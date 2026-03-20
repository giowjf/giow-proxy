// GIOW Downloader — Cloudflare Worker Proxy
// Recebe GET /proxy?url=<URL_youtube>&filename=<nome>
// Faz fetch server-side (sem CORS) e faz pipe dos bytes pro browser

const ALLOWED_ORIGINS = [
  "https://downloader.giow.pro",
  "https://giow.pro",
];

const ALLOWED_HOSTS = [
  "googlevideo.com",
  "youtube.com",
  "youtu.be",
];

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "giow-proxy" });
    }

    // Rota principal: /proxy?url=...&filename=...
    if (url.pathname === "/proxy") {
      return handleProxy(request, url);
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};

async function handleProxy(request, url) {
  const targetUrl = url.searchParams.get("url");
  const filename = url.searchParams.get("filename") || "video.mp4";

  // Valida presença da URL
  if (!targetUrl) {
    return jsonResponse({ error: "missing url parameter" }, 400);
  }

  // Valida que é realmente uma URL do YouTube
  // Evita que o Worker vire proxy genérico
  let targetHost;
  try {
    targetHost = new URL(targetUrl).hostname;
  } catch {
    return jsonResponse({ error: "invalid url" }, 400);
  }

  const isAllowed = ALLOWED_HOSTS.some(h => targetHost.endsWith(h));
  if (!isAllowed) {
    return jsonResponse({ error: "url not allowed" }, 403);
  }

  // Suporta Range requests — essencial para browsers retomarem downloads
  const rangeHeader = request.headers.get("Range");

  const fetchHeaders = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36",
    "Referer": "https://www.youtube.com/",
    "Origin": "https://www.youtube.com",
  };

  if (rangeHeader) {
    fetchHeaders["Range"] = rangeHeader;
  }

  let ytResponse;
  try {
    ytResponse = await fetch(targetUrl, {
      headers: fetchHeaders,
      // CF Worker faz o fetch sem restrição CORS — é server-side
    });
  } catch (err) {
    return jsonResponse({ error: "fetch failed", details: err.message }, 502);
  }

  if (!ytResponse.ok && ytResponse.status !== 206) {
    return jsonResponse(
      { error: `YouTube retornou ${ytResponse.status}` },
      ytResponse.status
    );
  }

  // Monta headers da resposta pro browser
  const responseHeaders = new Headers();

  // CORS — permite que downloader.giow.pro faça fetch deste Worker
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type");

  // Repassa headers relevantes do YouTube
  const passthroughHeaders = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Cache-Control",
  ];
  for (const h of passthroughHeaders) {
    const val = ytResponse.headers.get(h);
    if (val) responseHeaders.set(h, val);
  }

  // Força download com o nome do arquivo
  const safeFilename = filename.replace(/[^\w\s.\-()]/g, "_").slice(0, 150);
  responseHeaders.set(
    "Content-Disposition",
    `attachment; filename="${safeFilename}"`
  );

  // Streaming direto — o Worker faz pipe sem bufferizar tudo na memória
  return new Response(ytResponse.body, {
    status: ytResponse.status,
    headers: responseHeaders,
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
