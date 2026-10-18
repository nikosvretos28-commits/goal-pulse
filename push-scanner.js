const API = (process.env.GOAL_PULSE_API_URL || "https://goal-pulse-analytics.onrender.com").replace(/\/$/, "");
const TOKEN = process.env.PUSH_SCAN_TOKEN || "";
if (!TOKEN) {
  console.error("PUSH_SCAN_TOKEN is required");
  process.exit(1);
}
async function run() {
  const response = await fetch(API + "/api/push/scan", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(55000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Scan request failed (" + response.status + "): " + body.slice(0, 300));
  console.log(body);
}
run().catch(error => { console.error(error.message || error); process.exitCode = 1; });
