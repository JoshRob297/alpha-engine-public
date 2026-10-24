/**
 * Driver On-Chain de Aerodrome Slipstream en Base L2
 * Interactua con el contrato oficial NonfungiblePositionManager
 * Direccion oficial en Base: 0x827922686190790b37229fd06084350E74485b72
 */

export const AERODROME_POSITION_MANAGER_ADDRESS = "0x827922686190790b37229fd06084350E74485b72";
export const BASE_RPC_URL = "https://mainnet.base.org";

export interface MintParams {
  token0: string;
  token1: string;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  recipient: string;
  deadline: number;
}

export class AerodromeSlipstreamDriver {
  private rpcUrl: string;

  constructor(rpcUrl = BASE_RPC_URL) {
    this.rpcUrl = rpcUrl;
  }

  /**
   * Consulta el balance de ETH nativo en Base
   */
  public async getEthBalance(address: string): Promise<number> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [address, "latest"],
        }),
      });
      const data = await res.json();
      const wei = BigInt(data.result || "0x0");
      return Number(wei) / 1e18;
    } catch (err) {
      console.error("Error consultando balance en Base:", err);
      return 0;
    }
  }

  /**
   * Codifica la llamada calldata para mint (compatible con ABI Uniswap v3 / Aerodrome Slipstream Position Manager)
   * Función: mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper,
   *                uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min,
   *                address recipient, uint256 deadline))
   * Selector oficial: 0x88316456
   */
  public encodeMintCall(params: MintParams): string {
    const selector = "0x88316456";
    const padAddress = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const padInt24 = (num: number) => {
      // Manejo de complemento a dos para ticks negativos
      const val = BigInt.asUintN(256, BigInt(num));
      return val.toString(16).padStart(64, "0");
    };
    const padUint256 = (valStr: string | number) => {
      const b = BigInt(valStr);
      return b.toString(16).padStart(64, "0");
    };

    const encoded = [
      padAddress(params.token0),
      padAddress(params.token1),
      padInt24(params.tickSpacing),
      padInt24(params.tickLower),
      padInt24(params.tickUpper),
      padUint256(params.amount0Desired),
      padUint256(params.amount1Desired),
      padUint256(params.amount0Min),
      padUint256(params.amount1Min),
      padAddress(params.recipient),
      padUint256(params.deadline),
    ].join("");

    return selector + encoded;
  }

  /**
   * Consulta el número de NFTs de posiciones LP que posee una dirección
   * ERC721: balanceOf(address) -> uint256 (selector: 0x70a08231)
   */
  public async getPositionCount(ownerAddress: string): Promise<number> {
    const padAddress = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const data = "0x70a08231" + padAddress(ownerAddress);

    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: AERODROME_POSITION_MANAGER_ADDRESS, data }, "latest"],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return 0;
      const json = await res.json();
      if (!json.result || json.result === "0x") return 0;
      return Number(BigInt(json.result));
    } catch {
      return 0;
    }
  }

  /**
   * Codifica la llamada calldata para burn / decreaseLiquidity
   * Función: decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline))
   * Selector oficial: 0x0c49ccbe
   */
  public encodeDecreaseLiquidityCall(tokenId: number, liquidity: string, deadline: number): string {
    const selector = "0x0c49ccbe";
    const padUint256 = (valStr: string | number) => BigInt(valStr).toString(16).padStart(64, "0");
    const encoded = [
      padUint256(tokenId),
      padUint256(liquidity),
      padUint256(0), // amount0Min
      padUint256(0), // amount1Min
      padUint256(deadline),
    ].join("");
    return selector + encoded;
  }

  /**
   * Codifica la llamada calldata para collect (cobro de fees acumuladas)
   * Función: collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max))
   * Selector oficial: 0xfc6f7865
   */
  public encodeCollectCall(tokenId: number, recipient: string): string {
    const selector = "0xfc6f7865";
    const padAddress = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const padUint256 = (valStr: string | number) => BigInt(valStr).toString(16).padStart(64, "0");
    const maxUint128 = (BigInt(2) ** BigInt(128) - BigInt(1)).toString();

    const encoded = [
      padUint256(tokenId),
      padAddress(recipient),
      padUint256(maxUint128),
      padUint256(maxUint128),
    ].join("");
    return selector + encoded;
  }

  /**
   * Consulta el tokenId de una posición por su índice de dueño
   * ERC721Enumerable: tokenOfOwnerByIndex(address, uint256) -> uint256 (selector: 0x2f745c59)
   */
  public async getTokenOfOwnerByIndex(ownerAddress: string, index: number): Promise<number | null> {
    const padAddress = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const padUint256 = (val: number) => BigInt(val).toString(16).padStart(64, "0");
    const data = "0x2f745c59" + padAddress(ownerAddress) + padUint256(index);

    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: AERODROME_POSITION_MANAGER_ADDRESS, data }, "latest"],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      const json = await res.json();
      if (!json.result || json.result === "0x") return null;
      return Number(BigInt(json.result));
    } catch {
      return null;
    }
  }

  /**
   * Consulta los detalles de una posición NFT Slipstream en Base L2
   * positions(uint256) -> (nonce, operator, token0, token1, tickSpacing, tickLower, tickUpper, liquidity, ...)
   * Selector: 0x99fbab88
   */
  public async getPositionDetails(tokenId: number): Promise<{
    token0: string;
    token1: string;
    tickLower: number;
    tickUpper: number;
    liquidity: string;
  } | null> {
    const padUint256 = (val: number) => BigInt(val).toString(16).padStart(64, "0");
    const data = "0x99fbab88" + padUint256(tokenId);

    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: AERODROME_POSITION_MANAGER_ADDRESS, data }, "latest"],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      const json = await res.json();
      const raw = json.result?.replace(/^0x/, "");
      if (!raw || raw.length < 64 * 8) return null;

      // Desempaquetar palabras ABI
      const token0 = "0x" + raw.slice(64 * 2 + 24, 64 * 3);
      const token1 = "0x" + raw.slice(64 * 3 + 24, 64 * 4);
      const tickLowerHex = raw.slice(64 * 5, 64 * 6);
      const tickUpperHex = raw.slice(64 * 6, 64 * 7);
      const liquidityHex = raw.slice(64 * 7, 64 * 8);

      const toSigned24 = (hex: string) => {
        let b = BigInt("0x" + hex);
        if (b >= BigInt(2) ** BigInt(255)) {
          b -= BigInt(2) ** BigInt(256);
        }
        return Number(b);
      };

      return {
        token0,
        token1,
        tickLower: toSigned24(tickLowerHex),
        tickUpper: toSigned24(tickUpperHex),
        liquidity: BigInt("0x" + liquidityHex).toString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Estima el gas exacto requerido para una llamada calldata en Base L2
   */
  public async estimateGas(from: string, data: string, value = "0x0"): Promise<number> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_estimateGas",
          params: [{ from, to: AERODROME_POSITION_MANAGER_ADDRESS, data, value }],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return 240_000;
      const json = await res.json();
      if (json.result) {
        return Number(BigInt(json.result));
      }
      return 240_000;
    } catch {
      return 240_000;
    }
  }
}
