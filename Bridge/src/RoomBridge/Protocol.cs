using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RoomBridge;

public sealed class Hello
{
    public int ProtocolVersion { get; set; } = 1;
    public string Token { get; set; } = "";
    public string ClientNonce { get; set; } = "";
    public string? Epoch { get; set; }
    public string? ContractHash { get; set; }
    public string Version { get; set; } = "1";
    public string BuildHash { get; set; } = "";
    public JsonElement? Info { get; set; }
    public Manifest? Manifest { get; set; }
    public PlayerAuthorization[] Players { get; set; } = [];
}

public sealed class Welcome
{
    public string Type { get; set; } = "Welcome";
    public string? Code { get; set; }
    public string? ServerNonce { get; set; }
    public string? SessionId { get; set; }
}

public sealed class Manifest
{
    public FunctionSpec[] HostFunctions { get; set; } = [];
    public FunctionSpec[] ClientFunctions { get; set; } = [];
}

public sealed class FunctionSpec
{
    public int Id { get; set; }
    public string Schema { get; set; } = "";
    public int MaxPayloadBytes { get; set; } = 65536;
}

public sealed class PlayerAuthorization
{
    public string Id { get; set; } = "";
    public string Token { get; set; } = "";
}

public sealed class Message
{
    public string Type { get; set; } = "";
    public string? RequestId { get; set; }
    public string? Code { get; set; }
    public int? FunctionId { get; set; }
    public string? ClientId { get; set; }
    [JsonConverter(typeof(RawJsonConverter))]
    public JsonElement? Payload { get; set; }
    public long? ExpectedRevision { get; set; }
    public long? Revision { get; set; }
    public int? RevokedCount { get; set; }
    public PlayerAuthorization[]? Players { get; set; }
    public string? ContractHash { get; set; }
    public RoomMetadata? RoomInfo { get; set; }
}

public sealed class RoomMetadata
{
    public string Version { get; set; } = "";
    public string BuildHash { get; set; } = "";
    public JsonElement? Info { get; set; }
    public Manifest Manifest { get; set; } = new();
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    RespectNullableAnnotations = true, MaxDepth = 32)]
[JsonSerializable(typeof(Hello))]
[JsonSerializable(typeof(Welcome))]
[JsonSerializable(typeof(Message))]
public partial class WireJson : JsonSerializerContext;

public static class Contracts
{
    public static string Hash(Manifest manifest)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            Write(writer, "host", manifest.HostFunctions);
            Write(writer, "client", manifest.ClientFunctions);
            writer.WriteEndArray();
        }
        return Convert.ToHexStringLower(SHA256.HashData(stream.GetBuffer().AsSpan(0, (int)stream.Length)));
    }

    static void Write(Utf8JsonWriter writer, string direction, FunctionSpec[] functions)
    {
        foreach (var function in functions.OrderBy(f => f.Id))
        {
            writer.WriteStartArray(); writer.WriteStringValue(direction);
            writer.WriteNumberValue(function.Id); writer.WriteStringValue(function.Schema);
            writer.WriteNumberValue(function.MaxPayloadBytes); writer.WriteEndArray();
        }
    }

    public static bool Valid(Manifest manifest, int maxPayload)
    {
        return ValidFunctions(manifest.HostFunctions, maxPayload) && ValidFunctions(manifest.ClientFunctions, maxPayload);
    }

    static bool ValidFunctions(FunctionSpec[] functions, int maxPayload) =>
        functions.Length <= 256 && functions.All(f => f is not null) && functions.Select(f => f.Id).Distinct().Count() == functions.Length &&
        functions.All(f => f.Id > 0 && f.MaxPayloadBytes is > 0 && f.MaxPayloadBytes <= maxPayload &&
            f.Schema.Length is > 0 and <= 128 && f.Schema.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or ':'));
}

public sealed class ProtocolException(string code) : Exception(code);

// Payload is parsed and bounded on receive. Preserve its original JSON bytes instead
// of HTML-escaping Unicode and inflating an otherwise valid message during relay.
public sealed class RawJsonConverter : JsonConverter<JsonElement>
{
    public override JsonElement Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => JsonElement.ParseValue(ref reader);
    public override void Write(Utf8JsonWriter writer, JsonElement value, JsonSerializerOptions options) => writer.WriteRawValue(value.GetRawText(), skipInputValidation: true);
}
