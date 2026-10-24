async function testLaya() {
  try {
    console.log("Probando Laya en <compute-node-ip>:8088...");
    const res = await fetch("http://<compute-node-ip>:8088/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { ticker: "BTC", spread_bps: 5.0, ofi: 0.1, depth_ratio: 1.0, is_evaporating: false }
      }),
      signal: AbortSignal.timeout(5000)
    });
    console.log("Status:", res.status);
    const body = await res.json();
    console.log("Laya respondió:", body);
  } catch (e: any) {
    console.error("Error en Laya:", e.message);
  }
}
testLaya();
