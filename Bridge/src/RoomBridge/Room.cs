using System.Text;

namespace RoomBridge;

public sealed class Room
{
    public object Gate { get; } = new();
    readonly BridgeOptions options;
    readonly RoomRegistry registry;
    readonly Dictionary<int, FunctionSpec> hostFunctions;
    readonly Dictionary<int, FunctionSpec> clientFunctions;
    readonly Dictionary<string, Peer> clients = new(StringComparer.Ordinal);
    Dictionary<string, string> authorization;
    readonly string root;
    readonly string epoch;
    bool closed;
    long revision;
    public string Id { get; }
    public string ContractHash { get; }
    public Peer Host { get; }
    readonly RoomMetadata metadata;

    public Room(string id, Hello hello, Peer host, BridgeOptions options, RoomRegistry registry)
    {
        this.options = options; this.registry = registry;
        Id = id; Host = host; root = hello.Token; epoch = hello.Epoch!;
        if (hello.Manifest is null || !Contracts.Valid(hello.Manifest, options.MaxMessageBytes - 2048)) throw new ProtocolException("InvalidManifest");
        ContractHash = Contracts.Hash(hello.Manifest);
        if (hello.Info is { } info && Encoding.UTF8.GetByteCount(info.GetRawText()) > 4096) throw new ProtocolException("MetadataTooLarge");
        metadata = new RoomMetadata { Version = hello.Version, BuildHash = hello.BuildHash, Info = hello.Info, Manifest = hello.Manifest };
        if (System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new Message { Type = "Ready", Revision = long.MaxValue, ContractHash = ContractHash, RoomInfo = metadata }, WireJson.Default.Message).Length > options.MaxMessageBytes)
            throw new ProtocolException("MetadataTooLarge");
        hostFunctions = hello.Manifest.HostFunctions.ToDictionary(f => f.Id);
        clientFunctions = hello.Manifest.ClientFunctions.ToDictionary(f => f.Id);
        authorization = ValidateAuthorization(hello.Players);
    }

    Dictionary<string, string> ValidateAuthorization(PlayerAuthorization[] players)
    {
        if (players.Length > options.MaxPlayersPerRoom) throw new ProtocolException("InvalidAuthorization");
        var byToken = new Dictionary<string, string>(StringComparer.Ordinal);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in players)
        {
            if (entry is null || !RoomRegistry.ValidId(entry.Id) || !ids.Add(entry.Id) ||
                !Tokens.Validate(root, Id, epoch, entry.Id, entry.Token) || !byToken.TryAdd(entry.Token, entry.Id))
                throw new ProtocolException("InvalidAuthorization");
        }
        return byToken;
    }

    public void Join(Peer client, string? contractHash)
    {
        lock (Gate)
        {
            if (closed || Host.Stopped) throw new ProtocolException("RoomUnavailable");
            if (contractHash != ContractHash) throw new ProtocolException("ContractMismatch");
            if (!authorization.TryGetValue(client.Token, out var id)) throw new ProtocolException("Unauthorized");
            if (clients.ContainsKey(id)) throw new ProtocolException("AlreadyConnected");
            client.ClientId = id; client.Room = this; client.Active = true;
            clients.Add(id, client);
            client.Enqueue(new() { Type = "Ready", Revision = revision, ContractHash = ContractHash, RoomInfo = metadata });
            SendHost(new() { Type = "ClientJoined", ClientId = id });
        }
    }

    public void Handle(Peer sender, Message message)
    {
        lock (Gate)
        {
            if (closed || !sender.Active || sender.Stopped || Host.Stopped) { sender.Stop("RoomUnavailable"); return; }
            if (message.RequestId?.Length > 128) throw new ProtocolException("InvalidRequestId");
            if (!sender.IsHost && message.ClientId is not null) throw new ProtocolException("IdentitySpoof");
            switch (message.Type)
            {
                case "Ping": sender.Enqueue(new() { Type = "Pong", RequestId = message.RequestId }); break;
                case "Invoke" when !sender.IsHost:
                    ValidateCall(hostFunctions, message);
                    SendHost(new() { Type = "ClientInvoke", ClientId = sender.ClientId, FunctionId = message.FunctionId, RequestId = message.RequestId, Payload = message.Payload }, sender);
                    break;
                case "InvokeClient" when sender.IsHost:
                    ValidateCall(clientFunctions, message);
                    if (message.ClientId is null || !clients.TryGetValue(message.ClientId, out var recipient) || !recipient.Active || recipient.Stopped)
                    { Error(message, "ClientUnavailable"); break; }
                    recipient.Enqueue(new() { Type = "Invoke", FunctionId = message.FunctionId, RequestId = message.RequestId, Payload = message.Payload }, sender);
                    break;
                case "ReplaceAuthorization" when sender.IsHost: Replace(message); break;
                default: throw new ProtocolException("ForbiddenMessage");
            }
            if (Host.Stopped) CloseLocked("HostUnavailable");
        }
    }

    static void ValidateCall(Dictionary<int, FunctionSpec> functions, Message message)
    {
        if (message.FunctionId is not int id || !functions.TryGetValue(id, out var spec)) throw new ProtocolException("UnknownFunction");
        if (message.Payload is { } payload && Encoding.UTF8.GetByteCount(payload.GetRawText()) > spec.MaxPayloadBytes)
            throw new ProtocolException("PayloadTooLarge");
    }

    void Replace(Message message)
    {
        if (message.ExpectedRevision != revision) { Error(message, "RevisionConflict"); return; }
        Dictionary<string, string> updated;
        try { updated = ValidateAuthorization(message.Players ?? throw new ProtocolException("InvalidAuthorization")); }
        catch (ProtocolException) { Error(message, "InvalidAuthorization"); return; }
        authorization = updated; revision++;
        int revoked = 0;
        foreach (var pair in clients.ToArray())
        {
            var peer = pair.Value;
            if (updated.TryGetValue(peer.Token, out var id) && id == peer.ClientId) continue;
            clients.Remove(pair.Key); peer.Stop("AuthorizationRevoked"); revoked++;
            SendHost(new() { Type = "ClientLeft", ClientId = peer.ClientId, Code = "AuthorizationRevoked" });
        }
        SendHost(new() { Type = "AuthorizationReplaced", RequestId = message.RequestId, Revision = revision, RevokedCount = revoked });
    }

    void Error(Message request, string code) => SendHost(new() { Type = "Error", RequestId = request.RequestId, Code = code, Revision = revision });
    void SendHost(Message message, Peer? source = null)
    {
        if (!Host.Enqueue(message, source)) CloseLocked("HostUnavailable");
    }

    public void Leave(Peer peer)
    {
        lock (Gate)
        {
            peer.Active = false;
            if (ReferenceEquals(peer, Host)) { CloseLocked("HostDisconnected"); return; }
            // A late callback from an old connection must never remove its successor.
            if (peer.ClientId is { } id && clients.TryGetValue(id, out var current) && ReferenceEquals(current, peer))
            {
                clients.Remove(id);
                if (!closed) SendHost(new() { Type = "ClientLeft", ClientId = id });
            }
        }
    }

    public void Close(string reason) { lock (Gate) CloseLocked(reason); }
    void CloseLocked(string reason)
    {
        if (closed) return;
        closed = true;
        registry.Remove(this);
        Host.Stop(reason);
        foreach (var client in clients.Values) client.Stop(reason);
        clients.Clear(); authorization.Clear();
    }
}

public sealed class RoomRegistry(BridgeOptions options)
{
    readonly object gate = new();
    readonly Dictionary<string, Room> rooms = new(StringComparer.Ordinal);
    public static bool ValidId(string? value) => value is { Length: > 0 and <= 64 } && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    public void Add(Room room)
    {
        lock (gate)
        {
            if (rooms.ContainsKey(room.Id)) throw new ProtocolException("RoomExists");
            if (rooms.Count >= options.MaxRooms) throw new ProtocolException("RoomCapacity");
            rooms.Add(room.Id, room);
        }
    }
    public Room Find(string id)
    {
        lock (gate) return rooms.TryGetValue(id, out var room) ? room : throw new ProtocolException("RoomNotFound");
    }
    public void Remove(Room room)
    {
        lock (gate)
            if (rooms.TryGetValue(room.Id, out var current) && ReferenceEquals(current, room)) rooms.Remove(room.Id);
    }
    public void Shutdown()
    {
        Room[] snapshot; lock (gate) snapshot = rooms.Values.ToArray();
        foreach (var room in snapshot) room.Close("ServerShutdown");
    }
}
