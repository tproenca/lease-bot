# contract-rules.md — Lease Assistant Knowledge File

Regras de derivação e formatação de placeholders para geração de contratos.

---

## Regras de derivação

- **Data de término:** data de início + duração em meses (ex: 01/06/2026 + 30 meses = 31/11/2028 → ajuste para último dia do mês anterior: 30/11/2028)
- **Valor por extenso:** converta o valor numérico para texto (ex: R$ 2.500,00 → "dois mil e quinhentos reais")
- **CPF formatado:** aplique a máscara XXX.XXX.XXX-XX
- **Data por extenso:** ex: "01 de junho de 2026"
- Qualquer outro `derived_formula` definido no placeholder — siga a fórmula descrita

---

## Transformações de caso

Aplique a transformação indicada no campo `case` de cada placeholder:

- `maiúsculas` → tudo em maiúsculas
- `minúsculas` → tudo em minúsculas
- `título` → primeira letra de cada palavra em maiúscula
- `frase` → apenas a primeira letra da frase em maiúscula
