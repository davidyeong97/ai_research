import { randomBytes } from "node:crypto";

// 48 chars of base64url (36 random bytes -> exactly 48 chars, no padding).
console.log(randomBytes(36).toString("base64url"));
