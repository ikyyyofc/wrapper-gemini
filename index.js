import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "50mb" }));

const GEMMY_URL = "https://us-central1-gemmy-ai-bdc03.cloudfunctions.net/gemini";
const GEMMY_HEADERS = {
    "User-Agent": "okhttp/5.3.2",
    "Accept-Encoding": "identity", // matikan gzip biar stream bisa dibaca langsung
    "content-type": "application/json; charset=UTF-8"
};

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const { data } = await axios.post(
        "https://www.googleapis.com/identitytoolkit/v3/relyingparty/signupNewUser?key=AIzaSyAxof8_SbpDcww38NEQRhNh0Pzvbphh-IQ",
        { clientType: "CLIENT_TYPE_ANDROID" },
        {
            headers: {
                "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 12; SM-S9280 Build/AP3A.240905.015.A2)",
                "Content-Type": "application/json",
                "X-Android-Package": "com.jetkite.gemmy",
                "X-Android-Cert": "037CD2976D308B4EFD63EC63C48DC6E7AB7E5AF2",
                "X-Firebase-GMPID": "1:652803432695:android:c4341db6033e62814f33f2"
            }
        }
    );

    cachedToken = data.idToken;
    tokenExpiry = Date.now() + 55 * 60 * 1000;
    return cachedToken;
}

function buildPayload(modelName, body, isStream) {
    const { contents, generationConfig, systemInstruction, safetySettings, tools } = body;

    return {
        model: modelName,
        request: {
            contents: contents ?? [],
            generationConfig: generationConfig ?? {},
            safetySettings: safetySettings ?? [
                { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ],
            ...(tools            && { tools }),
            ...(systemInstruction && { systemInstruction })
        },
        stream: isStream
    };
}

// Kirim ke Gemmy tanpa streaming, kembalikan data mentah
async function callGemmy(payload, token) {
    const { data } = await axios.post(GEMMY_URL, payload, {
        headers: { ...GEMMY_HEADERS, authorization: `Bearer ${token}` }
    });
    return data;
}

// Kirim ke Gemmy dengan streaming, kembalikan axios stream response
async function callGemmyStream(payload, token) {
    return axios.post(GEMMY_URL, payload, {
        headers: { ...GEMMY_HEADERS, authorization: `Bearer ${token}` },
        responseType: "stream"
    });
}

// POST /v1beta/models/gemini-xxx:generateContent
// POST /v1beta/models/gemini-xxx:streamGenerateContent
app.post("/v1beta/models/:modelAndAction", async (req, res) => {
    try {
        const rawParam   = req.params.modelAndAction;
        const isStream   = rawParam.endsWith(":streamGenerateContent");
        const modelName  = rawParam.split(":")[0];

        const token   = await getToken();
        const payload = buildPayload(modelName, req.body, isStream);

        if (!isStream) {
            // ── Non-streaming: langsung forward response ──────────────────
            const data = await callGemmy(payload, token);
            return res.json(data);
        }

        // ── Streaming: reconstruct SSE yang 100% kompatibel Gemini CLI ───
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        const streamRes = await callGemmyStream(payload, token);

        let buffer = "";

        streamRes.data.on("data", (chunk) => {
            buffer += chunk.toString("utf8");

            // Gemini SSE format: "data: {...}\r\n\r\n" atau "data: {...}\n\n"
            // Kita split per blok SSE
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? ""; // simpan potongan terakhir yang belum lengkap

            for (const block of blocks) {
                const line = block.trim();
                if (!line) continue;

                if (line === "data: [DONE]") {
                    res.write("data: [DONE]\n\n");
                    continue;
                }

                // Ambil JSON dari "data: {...}"
                const jsonStr = line.startsWith("data: ") ? line.slice(6) : line;

                try {
                    const parsed = JSON.parse(jsonStr);
                    // Re-emit sebagai SSE chunk standar Gemini
                    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                } catch {
                    // Kalau bukan JSON valid (misal komentar SSE), skip
                    console.warn("[SKIP non-JSON chunk]", line.slice(0, 80));
                }
            }
        });

        streamRes.data.on("end", () => {
            // Proses sisa buffer kalau ada
            if (buffer.trim()) {
                const jsonStr = buffer.trim().startsWith("data: ")
                    ? buffer.trim().slice(6)
                    : buffer.trim();
                try {
                    const parsed = JSON.parse(jsonStr);
                    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                } catch { /* skip */ }
            }
            res.end();
        });

        streamRes.data.on("error", (err) => {
            console.error("[STREAM ERROR]", err.message);
            res.end();
        });

    } catch (err) {
        const status  = err.response?.status ?? 500;
        const message = err.response?.data   ?? { error: { message: err.message, status: "INTERNAL" } };
        console.error(`[ERROR ${status}]`, err.message);
        if (!res.headersSent) res.status(status).json(message);
        else res.end();
    }
});

app.get("/", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gemmy proxy → http://localhost:${PORT}`));
