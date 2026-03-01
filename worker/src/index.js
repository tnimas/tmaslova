export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(request, env, { ok: false, error: "method_not_allowed" }, 405);
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/lead") {
      return jsonResponse(request, env, { ok: false, error: "not_found" }, 404);
    }

    const origin = request.headers.get("Origin");
    if (origin && !isAllowedOrigin(origin, env)) {
      return jsonResponse(request, env, { ok: false, error: "origin_not_allowed" }, 403);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(request, env, { ok: false, error: "invalid_json" }, 400);
    }

    const name = cleanText(payload.name, 80);
    const phone = cleanText(payload.phone, 40);
    const consent = payload.consent === true;
    const page = cleanText(payload.page || "", 220);

    if (!name || name.length < 2) {
      return jsonResponse(request, env, { ok: false, error: "invalid_name" }, 400);
    }

    if (!phone || countDigits(phone) < 10) {
      return jsonResponse(request, env, { ok: false, error: "invalid_phone" }, 400);
    }

    if (!consent) {
      return jsonResponse(request, env, { ok: false, error: "consent_required" }, 400);
    }

    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatIds = parseChatIds(env.TELEGRAM_CHAT_IDS || env.TELEGRAM_CHAT_ID || "");

    if (!botToken || chatIds.length === 0) {
      return jsonResponse(request, env, { ok: false, error: "worker_not_configured" }, 500);
    }

    const userAgent = request.headers.get("User-Agent") || "";
    const ipAddress = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
    const submittedAtIso = new Date().toISOString();
    const submittedAtMoscow = formatMoscowDate(submittedAtIso);
    const dayKeyMoscow = getMoscowDayKey(new Date(submittedAtIso));
    const senderInfo = summarizeSender(userAgent);
    const contactPhone = buildContactPhone(phone);
    const contactName = splitName(name);

    const phoneLimit = toPositiveInt(env.MAX_SUBMISSIONS_PER_PHONE_PER_DAY, 3);
    const ipLimit = toPositiveInt(env.MAX_SUBMISSIONS_PER_IP_PER_DAY, 20);

    const rateLimit = await consumeRateLimit(env, {
      dayKey: dayKeyMoscow,
      phone: contactPhone || phone,
      ip: ipAddress,
      phoneLimit,
      ipLimit,
    });

    if (!rateLimit.allowed) {
      return jsonResponse(request, env, {
        ok: false,
        error: "rate_limited",
      }, 429);
    }

    const pageText = page || "-";
    const message = [
      "<b>Новая заявка</b> с " + escapeHtml(pageText),
      "",
      "<b>Имя:</b> " + escapeHtml(name),
      "<b>Телефон:</b> " + escapeHtml(phone),
      "",
      "Время (МСК): " + escapeHtml(submittedAtMoscow),
      "Отправлено с: " + escapeHtml(senderInfo),
    ].join("\n");

    for (const chatId of chatIds) {
      const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });

      if (!telegramResponse.ok) {
        const errorText = await telegramResponse.text();
        console.error("telegram_send_failed", telegramResponse.status, errorText);
        return jsonResponse(request, env, {
          ok: false,
          error: "telegram_send_failed",
          details: cleanText(errorText, 300),
        }, 502);
      }

      if (contactPhone) {
        const contactResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendContact`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            phone_number: contactPhone,
            first_name: contactName.firstName,
            last_name: contactName.lastName,
            vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:" + contactName.fullName + "\nTEL:" + contactPhone + "\nEND:VCARD",
          }),
        });

        if (!contactResponse.ok) {
          const contactErrorText = await contactResponse.text();
          console.error("telegram_send_contact_failed", contactResponse.status, contactErrorText);
        }
      }
    }

    return jsonResponse(request, env, { ok: true }, 200);
  },
};

export class RateLimiterDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return doJson({ ok: false, error: "method_not_allowed" }, 405);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return doJson({ ok: false, error: "invalid_json" }, 400);
    }

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length === 0) {
      return doJson({ ok: true, allowed: true }, 200);
    }

    const normalized = entries
      .map((entry) => {
        const key = cleanText(entry.key, 180);
        const limit = toPositiveInt(entry.limit, 0);
        return { key, limit };
      })
      .filter((entry) => entry.key && entry.limit > 0);

    if (normalized.length === 0) {
      return doJson({ ok: true, allowed: true }, 200);
    }

    const keys = normalized.map((entry) => entry.key);
    const current = await this.state.storage.get(keys);
    const updates = [];

    for (const entry of normalized) {
      const rawCount = current.get(entry.key);
      const count = Number.isFinite(rawCount) ? rawCount : 0;
      if (count >= entry.limit) {
        return doJson({
          ok: true,
          allowed: false,
          key: entry.key,
          limit: entry.limit,
          count,
        }, 200);
      }

      updates.push({
        key: entry.key,
        count: count + 1,
      });
    }

    await Promise.all(updates.map((item) => this.state.storage.put(item.key, item.count)));
    return doJson({ ok: true, allowed: true }, 200);
  }
}

function parseChatIds(raw) {
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function countDigits(value) {
  return String(value).replace(/\D/g, "").length;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function consumeRateLimit(env, params) {
  const limiter = env.RATE_LIMITER;
  if (!limiter) {
    return { allowed: true };
  }

  const phoneKey = normalizePhoneKey(params.phone);
  const ipKey = normalizeIpKey(params.ip);
  const dayKey = cleanText(params.dayKey, 20);
  const entries = [];

  if (phoneKey) {
    entries.push({
      key: "phone:" + dayKey + ":" + phoneKey,
      limit: params.phoneLimit,
    });
  }

  if (ipKey) {
    entries.push({
      key: "ip:" + dayKey + ":" + ipKey,
      limit: params.ipLimit,
    });
  }

  if (entries.length === 0) {
    return { allowed: true };
  }

  try {
    const id = limiter.idFromName("global-limiter");
    const stub = limiter.get(id);
    const response = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries }),
    });

    if (!response.ok) {
      console.error("rate_limiter_request_failed", response.status);
      return { allowed: true };
    }

    const data = await response.json();
    if (data && data.allowed === false) {
      return { allowed: false };
    }

    return { allowed: true };
  } catch (error) {
    console.error("rate_limiter_unavailable", error && error.message ? error.message : error);
    return { allowed: true };
  }
}

function normalizePhoneKey(value) {
  const phone = buildContactPhone(value);
  if (phone) {
    return phone.replace(/\D/g, "");
  }

  const digits = String(value || "").replace(/\D/g, "");
  return digits.slice(-15);
}

function normalizeIpKey(value) {
  return cleanText(String(value || "").split(",")[0], 80);
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function getMoscowDayKey(date) {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const day = parts.find((part) => part.type === "day");
  const month = parts.find((part) => part.type === "month");
  const year = parts.find((part) => part.type === "year");
  if (!day || !month || !year) {
    return "unknown-day";
  }

  return year.value + "-" + month.value + "-" + day.value;
}

function buildContactPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }

  let normalized = digits;

  if (digits.length === 10) {
    normalized = "7" + digits;
  } else if (digits.length === 11 && digits.startsWith("8")) {
    normalized = "7" + digits.slice(1);
  }

  if (normalized.length < 10) {
    return "";
  }

  return "+" + normalized;
}

function splitName(name) {
  const cleaned = cleanText(name, 120);
  if (!cleaned) {
    return {
      firstName: "Клиент",
      lastName: "",
      fullName: "Клиент",
    };
  }

  const parts = cleaned.split(" ").filter((part) => part.length > 0);
  const firstName = parts[0].slice(0, 64);
  const lastName = parts.slice(1).join(" ").slice(0, 64);

  return {
    firstName: firstName || "Клиент",
    lastName,
    fullName: [firstName, lastName].filter((item) => item.length > 0).join(" ").slice(0, 128) || "Клиент",
  };
}

function formatMoscowDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function summarizeSender(rawUa) {
  const ua = String(rawUa || "").toLowerCase();

  let browser = "Браузер";
  if (ua.includes("yabrowser/")) {
    browser = "Yandex Browser";
  } else if (ua.includes("edg/")) {
    browser = "Edge";
  } else if (ua.includes("opr/") || ua.includes("opera")) {
    browser = "Opera";
  } else if (ua.includes("chrome/") && !ua.includes("edg/") && !ua.includes("opr/")) {
    browser = "Chrome";
  } else if (ua.includes("firefox/")) {
    browser = "Firefox";
  } else if (ua.includes("safari/") && !ua.includes("chrome/")) {
    browser = "Safari";
  } else if (ua.includes("telegram")) {
    browser = "Telegram";
  }

  let device = "Устройство";
  if (ua.includes("iphone")) {
    device = "iPhone";
  } else if (ua.includes("ipad")) {
    device = "iPad";
  } else if (ua.includes("android")) {
    device = "Android";
  } else if (ua.includes("windows")) {
    device = "Windows";
  } else if (ua.includes("macintosh") || ua.includes("mac os x")) {
    device = "Mac";
  } else if (ua.includes("linux")) {
    device = "Linux";
  }

  return browser + " / " + device;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isAllowedOrigin(origin, env) {
  if (!origin || origin === "null") {
    return true;
  }

  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return allowed.includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = isAllowedOrigin(origin, env) ? origin : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(request, env, payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
    },
  });
}

function doJson(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
