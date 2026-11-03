namespace RoomBridge;

public sealed class BridgeOptions
{
    public int MaxConnections { get; init; } = 10000;
    public int MaxRooms { get; init; } = 2000;
    public int MaxPlayersPerRoom { get; init; } = 256;
    public int MaxMessageBytes { get; init; } = 131072;
    public int MaxHandshakeBytes { get; init; } = 262144;
    public int QueueMessages { get; init; } = 128;
    public int QueueBytes { get; init; } = 1048576;
    public int HandshakeSeconds { get; init; } = 10;
    public int IdleSeconds { get; init; } = 45;
    public int SendSeconds { get; init; } = 10;
    public int MessagesPerSecond { get; init; } = 200;
    public int BytesPerSecond { get; init; } = 1048576;
    public bool AllowInsecureLoopback { get; init; }
    public string[] AllowedOrigins { get; init; } = [];

    // Explicit binding avoids runtime reflection and configuration binder dependencies in Native AOT.
    public static BridgeOptions Read(IConfiguration config)
    {
        int Get(string key, int fallback, int min, int max) =>
            int.TryParse(config["Bridge:" + key], out var value) && value >= min && value <= max ? value :
            config["Bridge:" + key] is null ? fallback : throw new ArgumentException("Invalid Bridge:" + key);
        return new()
        {
            MaxConnections = Get(nameof(MaxConnections), 10000, 1, 1000000),
            MaxRooms = Get(nameof(MaxRooms), 2000, 1, 100000),
            MaxPlayersPerRoom = Get(nameof(MaxPlayersPerRoom), 256, 1, 4096),
            MaxMessageBytes = Get(nameof(MaxMessageBytes), 131072, 4096, 1048576),
            MaxHandshakeBytes = Get(nameof(MaxHandshakeBytes), 262144, 1024, 2097152),
            QueueMessages = Get(nameof(QueueMessages), 128, 1, 4096),
            QueueBytes = Get(nameof(QueueBytes), 1048576, 1024, 16777216),
            HandshakeSeconds = Get(nameof(HandshakeSeconds), 10, 1, 60),
            IdleSeconds = Get(nameof(IdleSeconds), 45, 2, 600),
            SendSeconds = Get(nameof(SendSeconds), 10, 1, 60),
            MessagesPerSecond = Get(nameof(MessagesPerSecond), 200, 1, 100000),
            BytesPerSecond = Get(nameof(BytesPerSecond), 1048576, 1024, 1073741824),
            AllowInsecureLoopback = string.Equals(config["Bridge:AllowInsecureLoopback"], "true", StringComparison.OrdinalIgnoreCase),
            AllowedOrigins = (config["Bridge:AllowedOrigins"] ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        };
    }
}
