import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "50mb" }));

const CONFIG = {
    GEMMY_URL: "https://us-central1-gemmy-ai-bdc03.cloudfunctions.net/gemini",
    DEFAULT_MODEL: "gemini-pro-latest",
    HEADERS: {
        "User-Agent": "okhttp/5.3.2",
        "Accept-Encoding": "gzip",
        "content-type": "application/json; charset=UTF-8"
    }
};

// Cache token biar ga minta terus tiap request
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const response = await axios.post(
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

    cachedToken = response.data.idToken;
    // Firebase anonymous token biasanya expired 1 jam, cache 55 menit
    tokenExpiry = Date.now() + 55 * 60 * 1000;
    return cachedToken;
}

// Handle: POST /v1beta/models/:modelAndAction
// Contoh:  POST /v1beta/models/gemini-2.5-pro:generateContent
//          POST /v1beta/models/gemini-2.5-pro:streamGenerateContent
app.post("/v1beta/models/:modelAndAction", async (req, res) => {
    try {
        // Extract nama model dari path, buang action-nya
        // "gemini-2.5-pro:generateContent" → "gemini-2.5-pro"
        const [modelName] = req.params.modelAndAction.split(":");
        const isStream = req.params.modelAndAction.endsWith(":streamGenerateContent");

        const {
            contents,
            generationConfig,
            systemInstruction,
            safetySettings,
            tools
        } = req.body;

        const token = await getToken();

        const payload = {
            model: modelName || CONFIG.DEFAULT_MODEL,
            request: {
                contents: contents ?? [],
                generationConfig: generationConfig ?? {
                    thinkingConfig: { thinkingLevel: "HIGH" },
                    temperature: 0
                },
                safetySettings: safetySettings ?? [
                    { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ],
                tools: tools ?? [{ googleSearch: {}, urlContext: {} }],
                ...(systemInstruction && { systemInstruction })
            },
            stream: false  // Gemmy tidak support streaming, selalu false
        };

        const { data } = await axios.post(CONFIG.GEMMY_URL, payload, {
            headers: {
                ...CONFIG.HEADERS,
                authorization: `Bearer ${token}`
            }
        });

        if (isStream) {
            // Gemini CLI kadang request stream, tapi kita fake SSE-nya
            // dengan kirim satu chunk sekaligus lalu done
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            res.write(`data: ${JSON.stringify(data)}\r\n\r\n`);
            res.write("data: [DONE]\r\n\r\n");
            res.end();
        } else {
            res.json(data);
        }
    } catch (err) {
        const status = err.response?.status ?? 500;
        const message = err.response?.data ?? { error: { message: err.message } };
        console.error(`[ERROR] ${status}:`, message);
        res.status(status).json(message);
    }
});

// Health check
app.get("/", (req, res) => {
    res.json({ status: "ok", message: "Gemmy proxy is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Gemmy proxy running on http://localhost:${PORT}`);
});
