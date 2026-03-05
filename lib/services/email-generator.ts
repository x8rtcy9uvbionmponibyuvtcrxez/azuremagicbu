import { randomInt } from "crypto";

export type GeneratedEmail = {
  email: string;
  displayName: string;
  password?: string;
};

type ParsedName = {
  firstName: string;
  lastName: string;
  fullName: string;
};

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseNames(names: string[]): ParsedName[] {
  const parsed = names
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const parts = name.split(/\s+/).filter(Boolean);
      const firstRaw = parts[0] || "";
      const lastRaw = parts[1] || parts[0] || "";

      const firstName = normalizeToken(firstRaw);
      const lastName = normalizeToken(lastRaw);

      if (!firstName || !lastName) {
        throw new Error(`Invalid name: ${name}`);
      }

      return {
        firstName,
        lastName,
        fullName: name
      };
    });

  if (parsed.length === 0) {
    throw new Error("At least one valid inbox name is required");
  }

  return parsed;
}

function extractBreaks(name: string): string[] {
  const breaks: string[] = [];
  const lower = normalizeToken(name);
  for (let i = 1; i <= lower.length; i++) {
    breaks.push(lower.substring(0, i));
  }
  return breaks;
}

function sanitizeLocalPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
}

function randomSuffix(length = 2): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += alphabet[randomInt(0, alphabet.length)];
  }
  return result;
}

const COMMON_PASSWORDS = new Set([
  "password",
  "password123",
  "qwerty",
  "qwerty123",
  "letmein",
  "admin123",
  "welcome123",
  "12345678"
]);

function pick(source: string): string {
  return source[randomInt(0, source.length)];
}

function shuffle(chars: string[]): string[] {
  const result = [...chars];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function categoryCount(password: string): number {
  let count = 0;
  if (/[A-Z]/.test(password)) count += 1;
  if (/[a-z]/.test(password)) count += 1;
  if (/[0-9]/.test(password)) count += 1;
  if (/[^A-Za-z0-9]/.test(password)) count += 1;
  return count;
}

export function generateStrongPassword(options?: {
  length?: number;
  forbiddenTokens?: string[];
  maxAttempts?: number;
}): string {
  const length = Math.min(256, Math.max(8, options?.length ?? 16));
  const maxAttempts = options?.maxAttempts ?? 100;
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const symbols = "!@#$%&*_+-=?";
  const all = uppercase + lowercase + numbers + symbols;
  const forbidden = (options?.forbiddenTokens ?? [])
    .map((token) => token.toLowerCase().trim())
    .filter((token) => token.length >= 3);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const chars = [pick(uppercase), pick(lowercase), pick(numbers), pick(symbols)];
    while (chars.length < length) {
      chars.push(pick(all));
    }
    let password = shuffle(chars).join("");

    // Ensure password doesn't start with a special character (M365 requirement)
    if (/[^A-Za-z0-9]/.test(password[0])) {
      const passwordChars = password.split("");
      const alphaIndex = passwordChars.findIndex((c, i) => i > 0 && /[A-Za-z0-9]/.test(c));
      if (alphaIndex > 0) {
        [passwordChars[0], passwordChars[alphaIndex]] = [passwordChars[alphaIndex], passwordChars[0]];
        password = passwordChars.join("");
      }
    }

    const lower = password.toLowerCase();

    const hasForbiddenToken = forbidden.some((token) => lower.includes(token));
    if (hasForbiddenToken) continue;
    if (COMMON_PASSWORDS.has(lower)) continue;
    if (categoryCount(password) < 3) continue;

    return password;
  }

  throw new Error("Unable to generate a compliant password");
}

function generateForSingleName(
  firstName: string,
  lastName: string,
  targetCount: number,
  domain: string,
  usedEmails: Set<string>
): string[] {
  const locals: string[] = [];
  const localSet = new Set<string>();
  const separators = [".", "_", "-", ""];

  const addLocal = (candidate: string): boolean => {
    if (locals.length >= targetCount) return true;

    const local = sanitizeLocalPart(candidate);
    if (!local) return false;

    const email = `${local}@${domain}`;
    if (localSet.has(local) || usedEmails.has(email)) return false;

    localSet.add(local);
    usedEmails.add(email);
    locals.push(local);

    return locals.length >= targetCount;
  };

  const firstBreaks = extractBreaks(firstName);
  const lastBreaks = extractBreaks(lastName);
  const firstInitial = firstBreaks[0] || firstName[0] || "u";
  const lastInitial = lastBreaks[0] || lastName[0] || "m";

  // Tier 1 + Tier 2 high-priority professional patterns.
  const primaryPatterns = [
    `${firstName}.${lastName}`,
    `${firstInitial}${lastName}`,
    `${firstInitial}.${lastName}`,
    `${firstName}${lastInitial}`,
    `${firstName}.${lastInitial}`,
    `${firstName}${lastName}`,
    `${firstName}_${lastName}`,
    `${firstName}-${lastName}`,
    `${lastName}.${firstName}`,
    `${lastName}${firstInitial}`,
    `${lastName}.${firstInitial}`,
    `${lastInitial}${firstName}`,
    `${lastInitial}.${firstName}`,
    `${lastName}${firstName}`,
    `${lastName}_${firstName}`,
    `${lastName}-${firstName}`
  ];

  for (const pattern of primaryPatterns) {
    if (addLocal(pattern)) break;
  }

  // Phase 1: progressive character extraction (forward + reverse).
  const phase1Start = locals.length;
  for (let fIdx = firstBreaks.length - 1; fIdx >= 0; fIdx--) {
    for (let lIdx = lastBreaks.length - 1; lIdx >= 0; lIdx--) {
      for (const sep of separators) {
        if (addLocal(firstBreaks[fIdx] + sep + lastBreaks[lIdx])) break;
      }
      if (locals.length >= targetCount) break;
    }
    if (locals.length >= targetCount) break;
  }

  if (locals.length < targetCount) {
    for (let lIdx = lastBreaks.length - 1; lIdx >= 0; lIdx--) {
      for (let fIdx = firstBreaks.length - 1; fIdx >= 0; fIdx--) {
        for (const sep of separators) {
          if (addLocal(lastBreaks[lIdx] + sep + firstBreaks[fIdx])) break;
        }
        if (locals.length >= targetCount) break;
      }
      if (locals.length >= targetCount) break;
    }
  }
  console.log(`[Email Gen] Phase 1: Generated ${locals.length - phase1Start} emails from pure combinations`);

  // Phase 2: professional suffixes fallback.
  if (locals.length < targetCount) {
    const phase2Start = locals.length;
    const suffixes = [
      "info",
      "contact",
      "hello",
      "mail",
      "team",
      "support",
      "help",
      "desk",
      "admin",
      "office",
      "service",
      "sales",
      "inbox",
      "email",
      "connect",
      "reach",
      "biz",
      "work",
      "pro",
      "group"
    ];

    const baseParts = [
      firstName,
      firstInitial,
      `${firstName}${lastName}`,
      `${firstName}.${lastName}`,
      `${lastName}${firstName}`,
      `${lastName}.${firstName}`
    ];

    for (const base of baseParts) {
      for (const suffix of suffixes) {
        addLocal(`${base}.${suffix}`);
        if (locals.length >= targetCount) break;
      }
      if (locals.length >= targetCount) break;
    }

    console.log(`[Email Gen] Phase 2: Added ${locals.length - phase2Start} emails using professional suffixes`);
  }

  // Phase 3: strategic low numbers fallback.
  if (locals.length < targetCount) {
    const phase3Start = locals.length;
    const topPatterns = [
      `${firstName}.${lastName}`,
      `${firstName}${lastName}`,
      `${firstInitial}.${lastName}`,
      `${firstName}.${lastInitial}`
    ];

    for (const pattern of topPatterns) {
      for (let num = 1; num <= 20; num++) {
        addLocal(`${pattern}${num}`);
        if (locals.length >= targetCount) break;
      }
      if (locals.length >= targetCount) break;
    }

    console.log(`[Email Gen] Phase 3: Added ${locals.length - phase3Start} emails using strategic numbers (1-20)`);
  }

  // Phase 4: extended numbers ultimate fallback.
  if (locals.length < targetCount) {
    console.log("[Email Gen] Phase 4: Used extended numbers fallback (extreme case)");
    const primaryPattern = sanitizeLocalPart(`${firstName}.${lastName}`) || `${firstName}${lastName}` || randomSuffix(5);
    let num = 21;

    while (locals.length < targetCount) {
      addLocal(`${primaryPattern}${num}`);
      num += 1;
    }
  }

  return locals.slice(0, targetCount);
}

export function generateEmailVariations(names: string[], domain: string, totalCount = 99): GeneratedEmail[] {
  const safeCount = Math.max(1, totalCount);
  const parsedNames = parseNames(names);
  const normalizedDomain = domain.toLowerCase().trim();

  const emailsPerName = Math.floor(safeCount / parsedNames.length);
  const remainder = safeCount % parsedNames.length;

  console.log(`[Email Gen] Generating ${safeCount} emails for ${parsedNames.length} name(s)`);
  console.log(`[Email Gen] Distribution: ${emailsPerName} per name, remainder: ${remainder}`);

  const usedEmails = new Set<string>();
  const results: GeneratedEmail[] = [];

  for (let i = 0; i < parsedNames.length; i++) {
    const { firstName, lastName, fullName } = parsedNames[i];
    const targetForName = emailsPerName + (i < remainder ? 1 : 0);
    const locals = generateForSingleName(firstName, lastName, targetForName, normalizedDomain, usedEmails);

    for (const local of locals) {
      results.push({
        email: `${local}@${normalizedDomain}`,
        displayName: fullName
      });
    }
  }

  const finalResults = results.slice(0, safeCount);

  if (finalResults.length !== safeCount) {
    throw new Error(`Expected ${safeCount} emails, generated ${finalResults.length}`);
  }

  const uniqueCheck = new Set(finalResults.map((item) => item.email));
  if (uniqueCheck.size !== finalResults.length) {
    throw new Error("Duplicate emails detected");
  }

  for (const item of finalResults) {
    if (!item.email || !item.email.includes("@")) {
      throw new Error(`Invalid email format: ${item.email}`);
    }
    if (!item.displayName) {
      throw new Error("Missing display name");
    }
    if (item.password && item.password.length < 8) {
      throw new Error("Invalid password");
    }
  }

  console.log(`[Email Gen] ✅ Complete: Generated exactly ${finalResults.length} unique emails`);
  return finalResults;
}
