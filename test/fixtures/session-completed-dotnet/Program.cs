using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

if (args.Length != 1)
    throw new ArgumentException("Pass the fixed session-completed-v1.json path to verify; no files are rewritten.");

DateTime[] sourceInstants =
[
    new DateTime(2024, 2, 29, 23, 59, 59, DateTimeKind.Utc).AddTicks(1234560),
    new DateTime(2024, 2, 29, 23, 59, 59, DateTimeKind.Utc).AddTicks(1234570),
    new DateTime(1, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddTicks(10),
    new DateTime(9999, 12, 31, 23, 59, 59, DateTimeKind.Utc).AddTicks(9999990)
];
string[] suffixes = ["c", "d", "e", "f"];
SessionCompletedEnvelope[] envelopes = sourceInstants.Select((instant, index) =>
    new SessionCompletedEnvelope("SESSION_COMPLETED", new SessionCompletedData(
        1,
        Guid.Parse("ABCDEF12-3456-4789-ABCD-123456789AB" + suffixes[index]),
        Guid.Parse("12345678-ABCD-4123-ABCD-123456789AB" + suffixes[index]),
        1,
        instant.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture)))).ToArray();

using JsonDocument expected = JsonDocument.Parse(File.ReadAllText(args[0]));
if (JsonSerializer.Serialize(expected.RootElement) != JsonSerializer.Serialize(envelopes))
    throw new InvalidOperationException(".NET serializer differs from the fixed v1 wire fixtures.");
Console.WriteLine("4 fixed SESSION_COMPLETED envelopes match .NET serialization exactly.");

internal sealed record SessionCompletedData(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("eventId")] Guid EventId,
    [property: JsonPropertyName("sessionId")] Guid SessionId,
    [property: JsonPropertyName("revision")] int Revision,
    [property: JsonPropertyName("completedAtUtc")] string CompletedAtUtc);

internal sealed record SessionCompletedEnvelope(
    [property: JsonPropertyName("pattern")] string Pattern,
    [property: JsonPropertyName("data")] SessionCompletedData Data);
