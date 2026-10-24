import { getMarketRegimeWithFailover } from "../src/guardrails/dual-regime-failover.js";

async function testParityFailover() {
  console.log("Probando Paridad 1:1 cuando Jev Cloud se desconecta:");
  
  // Simulamos un escenario de choque que requiere fail-over
  const res = await getMarketRegimeWithFailover("SOL", 25.0, -0.65, 0.20, -4.2);
  console.log("Resultado Fail-over:", res);
}

testParityFailover();
