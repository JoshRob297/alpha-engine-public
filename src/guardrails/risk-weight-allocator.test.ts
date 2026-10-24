import { describe, expect, it } from 'bun:test';
import { calculateDynamicRiskWeights, AssetCandidate } from './risk-weight-allocator';

describe('Optimizador Dinámico de Paridad de Riesgo Causal', () => {
  it('calcula ponderación 100% cuando hay 1 solo activo', () => {
    const candidates: AssetCandidate[] = [{ ticker: 'BTC', isAnchor: true }];
    const res = calculateDynamicRiskWeights(candidates, 'ACCUMULATE');
    expect(res.weights['BTC']).toBe(1.0);
    expect(res.cashReservePct).toBe(0.35);
  });

  it('asigna ponderación asimétrica para 2 activos (BTC y SOL) sin constantes quemadas', () => {
    const candidates: AssetCandidate[] = [
      { ticker: 'BTC', volatility: 0.25, sortino: 1.8, liquidityScore: 1.0, isAnchor: true },
      { ticker: 'SOL', volatility: 0.65, sortino: 1.3, liquidityScore: 0.7, isAnchor: false },
    ];
    const res = calculateDynamicRiskWeights(candidates, 'BALANCED_RANGE');
    
    // BTC debe tener mayor peso debido a menor volatilidad y mayor sortino
    expect(res.weights['BTC']).toBeGreaterThan(res.weights['SOL']);
    expect(res.weights['BTC'] + res.weights['SOL']).toBeCloseTo(1.0, 2);
    expect(res.weights['SOL']).toBeLessThanOrEqual(0.35); // Respeta el tope de altcoins
  });

  it('distribuye proporcionalmente para N = 3 activos (BTC, ETH, SOL)', () => {
    const candidates: AssetCandidate[] = [
      { ticker: 'BTC', volatility: 0.25, sortino: 1.8, isAnchor: true },
      { ticker: 'ETH', volatility: 0.35, sortino: 1.5, isAnchor: true },
      { ticker: 'SOL', volatility: 0.65, sortino: 1.2, isAnchor: false },
    ];
    const res = calculateDynamicRiskWeights(candidates, 'DEFENSIVE');
    const total = Object.values(res.weights).reduce((a, b) => a + b, 0);

    expect(total).toBeCloseTo(1.0, 2);
    expect(res.weights['BTC']).toBeGreaterThan(res.weights['ETH']);
    expect(res.weights['ETH']).toBeGreaterThan(res.weights['SOL']);
  });

  it('ajusta la reserva de efectivo según el régimen macro', () => {
    const candidates: AssetCandidate[] = [{ ticker: 'BTC' }, { ticker: 'SOL' }];
    const crashRes = calculateDynamicRiskWeights(candidates, 'VOLATILE_CRASH');
    const accumRes = calculateDynamicRiskWeights(candidates, 'ACCUMULATE');

    expect(crashRes.cashReservePct).toBe(0.50);
    expect(accumRes.cashReservePct).toBe(0.35);
  });
});
