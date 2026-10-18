const endpoint = process.env.PUSH_SCAN_URL || "https://goal-pulse-analytics.onrender.com/api/push/scan";
const token = process.env.PUSH_SCAN_TOKEN;

if (!token) {
  console.error("PUSH_SCAN_TOKEN is required");
  process.exit(1);
}

fetch(endpoint, {
  method: "POST",
  headers: { authorization: "Bearer " + token },
  signal: AbortSignal.timeout(55000)
}).then(async response => {
  const body = await response.text();
  console.log("Goal Pulse background scan:", response.status, body);
  if (!response.ok) process.exitCode = 1;
}).catch(error => {
  console.error("Goal Pulse background scan failed:", error.message);
  process.exitCode = 1;
});
