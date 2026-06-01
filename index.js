import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "50mb" }));

const GEMMY_URL = "https://us-central1-gemmy-ai-bdc03.cloudfunctions.net/gemini";

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

function safeErrorMessage(err) {
    try {
        const raw = err.response?.data;
        // Kalau data adalah stream (circular), jangan di-JSON
        if (!raw || typeof raw.pipe === "function") {
            return { error: { message: err.message, status: "INTERNAL" } };
        }
        return JSON.parse(JSON.stringify(raw));
    } catch {
        return { error: { message: err.message, status: "INTERNAL" } };
    }
}

app.post("/v1beta/models/:modelAndAction", async (req, res) => {
    try {
        const isStream  = req.params.modelAndAction.endsWith(":streamGenerateContent");
        const modelName = req.params.modelAndAction.split(":")[0];
        const payload   = { model: modelName, request: req.body, stream: isStream };
        const token     = await getToken();
        const headers   = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        };

        if (!isStream) {
            const { data } = await axios.post(GEMMY_URL, payload, { headers });
            return res.json(data);
        }

        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const streamRes = await axios.post(GEMMY_URL, payload, {
            headers,
            responseType: "stream"
        });

        streamRes.data.pipe(res);
        streamRes.data.on("error", () => res.end());

    } catch (err) {
        const status  = err.response?.status ?? 500;
        const message = safeErrorMessage(err);
        console.error(`[ERROR ${status}]`, err.message);
        if (!res.headersSent) res.status(status).json(message);
        else res.end();
    }
});

app.get("/", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gemmy proxy → http://localhost:${PORT}`));
