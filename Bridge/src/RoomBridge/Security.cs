using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace RoomBridge;

public static class Tokens
{
    public static string RandomToken() => Encode(RandomNumberGenerator.GetBytes(32));
    public static string Encode(ReadOnlySpan<byte> value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static byte[] Decode(string value)
    {
        if (value.Length > 256) throw new FormatException("Token too long");
        var result = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
        if (Encode(result) != value) throw new FormatException("Non-canonical token");
        return result;
    }
    public static bool IsSecret(string? value)
    {
        if (value is null || value.Length != 43) return false;
        try { return Decode(value).Length == 32; } catch (FormatException) { return false; }
    }
    public static string Issue(string root, string room, string epoch, string id)
    {
        if (!IsSecret(root) || !IsSecret(epoch)) throw new ArgumentException("Use random 32-byte host token and epoch");
        var nonce = RandomNumberGenerator.GetBytes(32);
        var tag = Tag(root, room, epoch, id, nonce);
        return Encode(nonce) + "." + Encode(tag);
    }
    public static bool Validate(string root, string room, string epoch, string id, string token)
    {
        if (token.Length != 87 || token[43] != '.') return false;
        try
        {
            var nonce = Decode(token[..43]); var tag = Decode(token[44..]);
            return CryptographicOperations.FixedTimeEquals(tag, Tag(root, room, epoch, id, nonce));
        }
        catch (FormatException) { return false; }
    }
    static byte[] Tag(string root, string room, string epoch, string id, byte[] nonce)
    {
        var rootBytes = Decode(root);
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, rootBytes, 32, Encoding.UTF8.GetBytes(epoch), Encoding.UTF8.GetBytes("RoomBridge/v1/issue/" + room));
        try
        {
            var idBytes = Encoding.UTF8.GetBytes(id);
            var input = new byte[idBytes.Length + 1 + nonce.Length];
            idBytes.CopyTo(input, 0); nonce.CopyTo(input, idBytes.Length + 1);
            return HMACSHA256.HashData(key, input);
        }
        finally { CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(rootBytes); }
    }
}

// One writer and one reader only. Each connection gets independently salted direction keys.
public sealed class SessionCipher : IDisposable
{
    readonly AesGcm send;
    readonly AesGcm receive;
    ulong sendSequence;
    ulong receiveSequence;
    public SessionCipher(string token, string clientNonce, string serverNonce, string sessionId, bool server)
    {
        var saltInput = Tokens.Decode(clientNonce).Concat(Tokens.Decode(serverNonce)).ToArray();
        var salt = SHA256.HashData(saltInput);
        var material = Encoding.UTF8.GetBytes(token);
        var c2s = HKDF.DeriveKey(HashAlgorithmName.SHA256, material, 32, salt, Encoding.UTF8.GetBytes("RoomBridge/v1/" + sessionId + "/c2s"));
        var s2c = HKDF.DeriveKey(HashAlgorithmName.SHA256, material, 32, salt, Encoding.UTF8.GetBytes("RoomBridge/v1/" + sessionId + "/s2c"));
        send = new AesGcm(server ? s2c : c2s, 16);
        receive = new AesGcm(server ? c2s : s2c, 16);
        CryptographicOperations.ZeroMemory(material); CryptographicOperations.ZeroMemory(c2s); CryptographicOperations.ZeroMemory(s2c);
    }
    public byte[] Encrypt(ReadOnlySpan<byte> plaintext)
    {
        if (sendSequence == ulong.MaxValue) throw new CryptographicException("Sequence exhausted");
        var record = new byte[plaintext.Length + 24];
        BinaryPrimitives.WriteUInt64BigEndian(record, sendSequence++);
        Span<byte> nonce = stackalloc byte[12]; nonce.Clear(); record.AsSpan(0, 8).CopyTo(nonce[4..]);
        send.Encrypt(nonce, plaintext, record.AsSpan(8, plaintext.Length), record.AsSpan(8 + plaintext.Length, 16), record.AsSpan(0, 8));
        return record;
    }
    public byte[] Decrypt(ReadOnlySpan<byte> record)
    {
        if (record.Length < 24 || receiveSequence == ulong.MaxValue || BinaryPrimitives.ReadUInt64BigEndian(record) != receiveSequence)
            throw new CryptographicException("Invalid sequence");
        Span<byte> nonce = stackalloc byte[12]; nonce.Clear(); record[..8].CopyTo(nonce[4..]);
        var plaintext = new byte[record.Length - 24];
        receive.Decrypt(nonce, record[8..^16], record[^16..], plaintext, record[..8]);
        receiveSequence++;
        return plaintext;
    }
    public void Dispose() { send.Dispose(); receive.Dispose(); }
}
