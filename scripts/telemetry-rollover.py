#!/usr/bin/env python3
"""
MANTENIMIENTO DE TELEMETRIA Y BUFFER RODANTE (ROLLOVER)

Mantiene la telemetria acotada:
  - data/laya_telemetry.jsonl      -> ultimos MAX_RECORDS registros
  - data/laya_telemetry.jsonl.old  -> archivo historico tambien acotado a MAX_RECORDS

El excedente se ARCHIVA en .old (append) en lugar de descartarse, y .old se recorta
a su propio limite. Antes este script no tenia invocador (timer/cron) y .old crecia sin
control (44,542 registros > 30,000 declarados).
"""

import os

DATA_DIR = os.environ.get("ALPHA_DATA_DIR", "/home/user/proyectos/alpha-engine/data")
TELEMETRY_PATH = os.path.join(DATA_DIR, "laya_telemetry.jsonl")
ARCHIVE_PATH = TELEMETRY_PATH + ".old"
MAX_RECORDS = 30000


def read_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, "r") as f:
        return f.readlines()


def write_lines(path, lines):
    with open(path, "w") as f:
        f.writelines(lines)


def main():
    lines = read_lines(TELEMETRY_PATH)
    total = len(lines)

    if total > MAX_RECORDS:
        overflow = lines[:-MAX_RECORDS]
        keep = lines[-MAX_RECORDS:]
        # Archivar el excedente (append) para no perder la cola de entrenamiento.
        with open(ARCHIVE_PATH, "a") as f:
            f.writelines(overflow)
        write_lines(TELEMETRY_PATH, keep)
        print(
            f"[ROLLOVER] Telemetria rotada: {total} -> {len(keep)} registros activos; "
            f"{len(overflow)} archivados en {os.path.basename(ARCHIVE_PATH)}."
        )
    else:
        print(f"[ROLLOVER] Buffer saludable: {total} de {MAX_RECORDS} registros maximos.")

    archive = read_lines(ARCHIVE_PATH)
    if len(archive) > MAX_RECORDS:
        trimmed = archive[-MAX_RECORDS:]
        write_lines(ARCHIVE_PATH, trimmed)
        print(
            f"[ROLLOVER] Archivo historico acotado: {len(archive)} -> {len(trimmed)} registros."
        )
    elif archive:
        print(f"[ROLLOVER] Archivo historico: {len(archive)} de {MAX_RECORDS} registros maximos.")


if __name__ == "__main__":
    main()
