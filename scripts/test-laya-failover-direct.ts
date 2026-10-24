async function testLayaFailoverDirect() {
  console.log("Probando Laya Local en Compute-node como Hot-Standby directo...");
  const t0 = Date.now();
  const res = await fetch("http://<compute-node-ip>:8088/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: {
        ticker: "SOL",
        spread_bps: 25.0,
        ofi: -0.65,
        depth_ratio: 0.20,
        is_evaporating: true,
        recent_change_pct: -4.2
      }
    }),
    signal: AbortSignal.timeout(3000)
  });

  const body: any = await res.json();
  console.log(`Laya respondió en ${Date.now() - t0}ms:`, body);
}

testLayaFailoverDirect();
