export const TEST_ED25519_KEYS = {
  publicKeyPem: [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEA6s5L1zMeKhVZJkHdc2CtkiVI1QudmTC5MsFM6keIXYk=",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n"),
  privateKeyPem: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEINME7Rv5nIHWl1lOXmFzNYV/AFk4synsj7ITtrAc5ZFs",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n"),
} as const;

export const TEST_RSA_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwsnmjpymeimAiQjQpGMC",
  "gJEeXOQ27gZZWY95wBhWN7aIZkvxCdhn6h/nL4OLySpUfd9cs4tzwaxHou6L/FPh",
  "SfoqjcTL2L5aNFTi/F5wPa8lpnMX8EbJra0bO4Bt3s048l0jiPto1cqKDXsWkWKG",
  "usPW/zYBB8rxUkUAUlHxhCHVeJPdhtQkW+JKrKS7VbtUifsjPfz9sU4eCWXapR2w",
  "3e9zVqSLiuSJk/BizSsBo7AhulqpqUFZKWc+T/UQDmzWMU8ZJ3EJZKw4hw0X5292",
  "mu4UqFS3/7ot81mbloFVifNXZET9zzxDdlWH4HgLOHaAZzXkV3u1qTEAp2gZs9mZ",
  "GwIDAQAB",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");
