const base = process.env.GOAL_PULSE_API_URL || "https://goal-pulse-analytics.onrender.com";
const token = process.env.PUSH_SCAN_TOKEN;
if (!token) {
  console.error("PUSH_SCAN_TOKEN is not configured");
  process.exit(1);
}
async function main() {
  const response = await fetch(base.replace(/\/$/, "") + "/api/push/scan", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(80000)
  });
  const body = await response.text();
  console.log("Goal Pulse background scan:", response.status, body);
  if (!response.ok) process.exitCode = 1;
}
main().catch(error => {
  console.error("Goal Pulse background scan failed:", error.message);
  process.exitCode = 1;
});
