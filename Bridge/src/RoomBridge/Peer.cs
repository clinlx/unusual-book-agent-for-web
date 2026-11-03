using System.Buffers;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;

namespace RoomBridge;

public static class Wire
{
    public static async Task<byte[]> Receive(WebSocket socket, int limit, CancellationToken cancellation, WebSocketMessageType? expected = null)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(Math.Min(limit + 1, 16384));
        try
        {
            using var output = new MemoryStream();
            WebSocketMessageType? kind = null;
            while (true)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(0, Math.Min(buffer.Length, limit + 1 - (int)output.Length)), cancellation);
                if (result.MessageType == WebSocketMessageType.Close) throw new EndOfStreamException();
                kind ??= result.MessageType;
                if (result.MessageType != kind || (expected.HasValue && expected != kind)) throw new ProtocolException("InvalidFrameType");
                if (output.Length + result.Count > limit) throw new ProtocolException("MessageTooLarge");
                output.Write(buffer, 0, result.Count);
                if (result.EndOfMessage) return output.ToArray();
            }
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }
}

internal sealed record Outgoing(byte[] Data, Peer? Source);

public sealed class Peer : IDisposable
{
    readonly WebSocket socket;
    readonly SessionCipher cipher;
    readonly BridgeOptions options;
    readonly Channel<Outgoing> outgoing;
    readonly CancellationTokenSource lifetime = new();
    readonly TaskCompletionSource receiveEnded = new(TaskCreationOptions.RunContinuationsAsynchronously);
    readonly object stopGate = new();
    long queuedBytes;
    int stopped;
    string stopReason = "Closed";
    double messageBudget;
    double byteBudget;
    long rateTimestamp = Stopwatch.GetTimestamp();
    public Room? Room { get; set; }
    public string? ClientId { get; set; }
    public string Token { get; }
    public bool IsHost { get; }
    public bool Active { get; set; }
    public bool Stopped => Volatile.Read(ref stopped) != 0;

    public Peer(WebSocket socket, SessionCipher cipher, BridgeOptions options, string token, bool host)
    {
        this.socket = socket; this.cipher = cipher; this.options = options; Token = token; IsHost = host;
        messageBudget = options.MessagesPerSecond; byteBudget = options.BytesPerSecond;
        outgoing = Channel.CreateBounded<Outgoing>(new BoundedChannelOptions(options.QueueMessages)
        { SingleReader = true, SingleWriter = false, FullMode = BoundedChannelFullMode.Wait, AllowSynchronousContinuations = false });
    }

    // Called under the owning room gate. Overflow disconnects instead of retaining unbounded memory.
    public bool Enqueue(Message message, Peer? source = null)
    {
        if (Stopped) return false;
        var data = JsonSerializer.SerializeToUtf8Bytes(message, WireJson.Default.Message);
        if (data.Length > options.MaxMessageBytes) { Stop("OutgoingMessageTooLarge"); return false; }
        if (Interlocked.Add(ref queuedBytes, data.Length) > options.QueueBytes)
        { Interlocked.Add(ref queuedBytes, -data.Length); Stop("SlowConsumer"); return false; }
        if (outgoing.Writer.TryWrite(new(data, source))) return true;
        Interlocked.Add(ref queuedBytes, -data.Length); Stop("SlowConsumer"); return false;
    }

    public void Stop(string reason)
    {
        lock (stopGate)
        {
            if (Stopped) return;
            stopReason = reason; Active = false; Volatile.Write(ref stopped, 1); outgoing.Writer.TryComplete();
        }
    }

    public async Task Run(CancellationToken requestAborted)
    {
        using var registration = requestAborted.Register(() => Stop("TransportClosed"));
        var sender = SendLoop();
        try
        {
            while (!Stopped)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(options.IdleSeconds));
                var record = await Wire.Receive(socket, options.MaxMessageBytes + 24, timeout.Token, WebSocketMessageType.Binary);
                ApplyRateLimit(record.Length);
                var plain = cipher.Decrypt(record);
                var message = JsonSerializer.Deserialize(plain, WireJson.Default.Message) ?? throw new ProtocolException("InvalidMessage");
                Room!.Handle(this, message);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or EndOfStreamException or System.Security.Cryptography.CryptographicException or JsonException or ProtocolException)
        { Stop(ex is ProtocolException p ? p.Message : "ConnectionClosed"); }
        finally
        {
            receiveEnded.TrySetResult();
            Room!.Leave(this);
            Stop("ConnectionClosed");
            await sender;
            socket.Abort();
        }
    }

    async Task SendLoop()
    {
        try
        {
            await foreach (var item in outgoing.Reader.ReadAllAsync(lifetime.Token))
            {
                Interlocked.Add(ref queuedBytes, -item.Data.Length);
                if (Stopped) break;
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(options.SendSeconds));
                ValueTask sending;
                lock (Room!.Gate)
                {
                    // Atomic with revocation: records already handed to transport cannot be recalled.
                    if (!Active || Stopped || (item.Source is not null && (!item.Source.Active || item.Source.Stopped))) continue;
                    var encrypted = cipher.Encrypt(item.Data);
                    sending = socket.SendAsync(encrypted.AsMemory(), WebSocketMessageType.Binary, true, timeout.Token);
                }
                await sending;
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or System.Security.Cryptography.CryptographicException)
        { Stop("SendFailed"); }
        finally
        {
            // Do not cancel ReceiveAsync before notifying: cancellation aborts ManagedWebSocket.
            // Only this loop writes, including terminal messages and close frames.
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                if (socket.State == WebSocketState.Open)
                {
                    var data = cipher.Encrypt(JsonSerializer.SerializeToUtf8Bytes(new Message { Type = "Disconnected", Code = stopReason }, WireJson.Default.Message));
                    await socket.SendAsync(data, WebSocketMessageType.Binary, true, timeout.Token);
                    await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, stopReason, timeout.Token);
                    // Allow the peer to observe the terminal frame and answer Close before aborting.
                    await receiveEnded.Task.WaitAsync(timeout.Token);
                    // A protocol violation may have ended the reader before Close was sent.
                    // In that case this loop temporarily owns receiving the close response.
                    while (socket.State == WebSocketState.CloseSent)
                        await Wire.Receive(socket, options.MaxMessageBytes + 24, timeout.Token);
                }
                else if (socket.State == WebSocketState.CloseReceived)
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Closed", timeout.Token);
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or System.Security.Cryptography.CryptographicException or EndOfStreamException or ProtocolException) { }
            lifetime.Cancel();
        }
    }

    void ApplyRateLimit(int bytes)
    {
        var now = Stopwatch.GetTimestamp(); var elapsed = Stopwatch.GetElapsedTime(rateTimestamp, now).TotalSeconds; rateTimestamp = now;
        messageBudget = Math.Min(options.MessagesPerSecond, messageBudget + elapsed * options.MessagesPerSecond);
        byteBudget = Math.Min(options.BytesPerSecond, byteBudget + elapsed * options.BytesPerSecond);
        if (messageBudget < 1 || byteBudget < bytes) throw new ProtocolException("RateLimited");
        messageBudget--; byteBudget -= bytes;
    }

    public void Dispose() { lifetime.Dispose(); cipher.Dispose(); }
}
