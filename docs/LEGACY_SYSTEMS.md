# ARCHIVO HISTÓRICO: SISTEMAS LEGACY Y LECCIONES DE LABORATORIO

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

Documento de preservación histórica y memoria técnica. Registra los enfoques explorados en las etapas preliminares de Alpha Engine, los sesgos detectados y las razones cuantitativas de su descarte.

---

## 1. El Sesgo de Lookahead Intradía (Malla de Alta Frecuencia en una Sola Vela)

### Enfoque Legacy
En las fases iniciales de diseño, los algoritmos de simulación permitían comprar en el precio mínimo (`low`) de una vela horaria y vender en el precio máximo (`high`) dentro de esa misma hora.

### Causa del Descarte
- **Lookahead Bias (Sesgo de Anticipación):** En un libro de órdenes real, el precio no realiza un ciclo perfecto de compra en el suelo y venta en el techo en minutos repetitivos.
- **Inflación Artificial:** Generaba decenas de operaciones teóricas que proyectaban retornos irreales de cientos de puntos porcentuales.
- **Estándar Adoptado:** Se prohibió la ejecución y salida en la misma vela, imponiendo una maduración horaria mínima de 1 hora entre fill y cierre para garantizar que el mercado respire.

---

## 2. El Peaje de Micro-Comisiones en FX (Scalping Rígido al +0.45%)

### Enfoque Legacy
El módulo de divisas legacy (`usd_mxn`, hoy erradicado) operaba con objetivos de salida ceñidos al **+0.45%** (aproximadamente 7 a 8 centavos de peso).

### Causa del Descarte
- **Devoración por Tarifas:** El exchange legacy cobraba 0.10% en la compra y 0.10% en la venta (0.20% de ida y vuelta). En operaciones de +0.45%, las comisiones del exchange representaban casi el 50% de la ganancia bruta.
- **Asimetría Negativa:** Un solo Stop Loss (-0.80%) requería al menos 3 a 4 operaciones ganadoras solo para recuperar el saldo.
- **Estándar Adoptado:** Evolución a **Micro-Swing (+0.85% / +0.95%)**: objetivos de 15 a 17 centavos de peso donde las comisiones representan menos del 20% del beneficio y la cuenta opera en terreno positivo neto.

---

## 3. El Candado de Enfriamiento por Reloj Ciego (16 Horas Fijas)

### Enfoque Legacy
Tras un corte defensivo o stop loss, el sistema activaba un cronómetro estático de 16 horas de congelamiento obligatorio (`cooldownUntil = Date.now() + 16 * 3600 * 1000`).

### Causa del Descarte
- **Incompatibilidad con la Microestructura:** Los mercados no se mueven por horarios de oficina.
  - Si el shock pasaba en 40 minutos y entraban compradores institucionales, el bot se quedaba atado de manos perdiéndose el rebote.
  - Si el mercado entraba en una sangría de 3 días, 16 horas era poco tiempo y volvía a comprar en plena caída.
- **Estándar Adoptado:** **Sensor Continuo de Laya sin Reloj**: Laya audita el flujo de órdenes en tiempo real (milisegundos) y levanta el veto en el segundo exacto en que la absorción compradora se normaliza (`OFI > +0.20` y `toxicFlow < 0.35`).

---

## 4. Take Profit Rígido en CEX (Pérdida de Tendencias Alcistas)

### Enfoque Legacy
En activos altamente volátiles como Solana, el sistema cerraba el 100% de la posición en un objetivo estático de +2.0%.

### Causa del Descarte
- **Asfixia de Rallies:** Cuando un activo experimentaba un impulso macro de +40% a +60%, el bot salía en los primeros dos dólares de subida y se quedaba en dólares viendo el cohete subir.
- **Estándar Adoptado:** **Trailing Take Profit + Running Profits**: Se asegura la ganancia inicial y se activa un Trailing Stop dinámico que persigue los máximos parabólicos con holgura adaptativa.
