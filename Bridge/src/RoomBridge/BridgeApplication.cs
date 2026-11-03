using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace RoomBridge;

public static class BridgeApplication
{
    public static WebApplication Build(string[] args)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = args, ContentRootPath = AppContext.BaseDirectory });
        builder.WebHost.UseKestrelHttpsConfiguration();
        builder.WebHost.ConfigureKestrel(server =>
        {
            server.Limits.MaxRequestHeadersTotalSize = 16384;
            server.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
            server.AddServerHeader = false;
        });
        builder.Services.AddRateLimiter(limits =>
        {
            limits.RejectionStatusCode = 429;
            limits.AddFixedWindowLimiter("upgrades", settings =>
            { settings.PermitLimit = 1000; settings.Window = TimeSpan.FromSeconds(1); settings.QueueLimit = 0; settings.AutoReplenishment = true; });
        });
        var options = BridgeOptions.Read(builder.Configuration);
        var registry = new RoomRegistry(options);
        var slots = new SemaphoreSlim(options.MaxConnections);
        var app = builder.Build();
        var webSockets = new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) };
        foreach (var origin in options.AllowedOrigins) webSockets.AllowedOrigins.Add(origin);
        app.UseWebSockets(webSockets);
        app.UseRateLimiter();
        app.MapGet("/health", () => Results.Text("ok"));
        app.Map("/server/{roomId}", (HttpContext context) => Connect(context, true, options, registry, slots)).RequireRateLimiting("upgrades");
        app.Map("/client/{roomId}", (HttpContext context) => Connect(context, false, options, registry, slots)).RequireRateLimiting("upgrades");
        app.Lifetime.ApplicationStopping.Register(registry.Shutdown);
        app.Lifetime.ApplicationStopped.Register(slots.Dispose);
        return app;
    }

    static async Task Connect(HttpContext context, bool host, BridgeOptions options, RoomRegistry registry, SemaphoreSlim slots)
    {
        var roomId = context.Request.RouteValues["roomId"] as string;
        if (!RoomRegistry.ValidId(roomId)) { context.Response.StatusCode = 400; return; }
        if (!context.Request.IsHttps && !(options.AllowInsecureLoopback && context.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip)))
        { context.Response.StatusCode = 426; return; }
        if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
        if (!slots.Wait(0)) { context.Response.StatusCode = 503; return; }
        try
        {
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            using var handshake = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
            handshake.CancelAfter(TimeSpan.FromSeconds(options.HandshakeSeconds));
            Peer? peer = null;
            bool welcomed = false;
            try
            {
                var bytes = await Wire.Receive(socket, options.MaxHandshakeBytes, handshake.Token, WebSocketMessageType.Text);
                var hello = JsonSerializer.Deserialize(bytes, WireJson.Default.Hello) ?? throw new ProtocolException("InvalidHello");
                if (hello.ProtocolVersion != 1) throw new ProtocolException("ProtocolVersionMismatch");
                if (!Tokens.IsSecret(hello.ClientNonce) || hello.Token.Length > 128 || hello.Version.Length > 64 || hello.BuildHash.Length > 128)
                    throw new ProtocolException("InvalidHello");
                if (host && (!Tokens.IsSecret(hello.Token) || !Tokens.IsSecret(hello.Epoch))) throw new ProtocolException("InvalidHostSecret");
                var serverNonce = Tokens.RandomToken(); var sessionId = Tokens.RandomToken();
                peer = new Peer(socket, new SessionCipher(hello.Token, hello.ClientNonce, serverNonce, sessionId, true), options, hello.Token, host);
                if (host)
                {
                    var room = new Room(roomId!, hello, peer, options, registry);
                    peer.Room = room; peer.Active = true;
                    // Publish only after Ready is queued, so racing clients cannot precede it.
                    peer.Enqueue(new() { Type = "Ready", Revision = 0, ContractHash = room.ContractHash });
                    registry.Add(room);
                }
                else registry.Find(roomId!).Join(peer, hello.ContractHash);
                var welcome = new Welcome { ServerNonce = serverNonce, SessionId = sessionId };
                await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(welcome, WireJson.Default.Welcome), WebSocketMessageType.Text, true, handshake.Token);
                welcomed = true;
                await peer.Run(context.RequestAborted);
            }
            catch (Exception ex) when (ex is ProtocolException or JsonException or CryptographicException or FormatException or OperationCanceledException or WebSocketException or EndOfStreamException)
            {
                if (!welcomed && socket.State == WebSocketState.Open)
                {
                    try
                    {
                        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                        var error = new Welcome { Type = "Error", Code = ex is ProtocolException p ? p.Message : "InvalidHandshake" };
                        await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(error, WireJson.Default.Welcome), WebSocketMessageType.Text, true, timeout.Token);
                        await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, error.Code, timeout.Token);
                        while (socket.State == WebSocketState.CloseSent)
                            await Wire.Receive(socket, options.MaxHandshakeBytes, timeout.Token);
                    }
                    catch (Exception e) when (e is WebSocketException or OperationCanceledException or EndOfStreamException or ProtocolException) { }
                }
            }
            finally { peer?.Room?.Leave(peer); peer?.Dispose(); }
        }
        finally { slots.Release(); }
    }
}
