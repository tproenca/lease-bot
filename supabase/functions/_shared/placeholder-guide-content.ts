// GENERATED — do not edit directly.
// Source: docs/placeholder-guide.md
// Run: deno run --allow-read --allow-write scripts/generate-shared.ts

export const PLACEHOLDER_GUIDE_CONTENT = `# Guia de Placeholders

Este documento descreve os marcadores disponíveis nos seus modelos de contrato e como usá-los.

## O que é um placeholder?

Placeholders são marcadores inseridos nos modelos de contrato para indicar onde informações variáveis serão preenchidas automaticamente. Eles seguem o formato \`{{nome_do_placeholder}}\`.

**Exemplo:** o modelo pode conter o texto \`O valor do aluguel mensal é de {{valor_aluguel}}.\`. Quando um contrato for gerado, o assistente substitui \`{{valor_aluguel}}\` pelo valor real informado na conversa.

## Como usar nos modelos

1. Abra o modelo de contrato no Google Docs.
2. Insira o marcador no local desejado com chaves duplas: \`{{nome_do_placeholder}}\`
3. O nome deve ser exatamente igual ao cadastrado na tabela ao final deste documento — respeite maiúsculas, minúsculas e underscores.

Se um placeholder obrigatório não for informado na conversa, o assistente solicitará o valor antes de gerar o contrato. Placeholders opcionais sem valor informado são deixados em branco no documento final.

## Tipos de formato

| Tipo | Descrição | Exemplo |
|------|-----------|---------|
| texto | Texto livre | Nome do inquilino, endereço |
| data | Data no formato DD/MM/AAAA | 01/06/2025 |
| cpf | CPF no formato XXX.XXX.XXX-XX | 123.456.789-00 |
| inteiro | Número inteiro sem casas decimais | 12 (meses de contrato) |
| moeda | Valor em reais | R$ 1.500,00 |

## Transformações de maiúsculas/minúsculas

Placeholders do tipo *texto* podem ter uma transformação de caso aplicada automaticamente ao preencher o documento:

| Transformação | Resultado |
|--------------|-----------|
| maiúsculas | TODO O TEXTO EM MAIÚSCULAS |
| minúsculas | todo o texto em minúsculas |
| título | Primeira Letra De Cada Palavra Em Maiúscula |
| frase | Apenas a primeira letra da frase em maiúscula |

## Placeholders derivados

Placeholders derivados são calculados automaticamente a partir de outro campo, sem que o proprietário precise informá-los manualmente. A fórmula de derivação é definida na conversa com o assistente.

**Exemplo:** \`{{valor_aluguel_extenso}}\` pode ser derivado de \`{{valor_aluguel}}\`, convertendo o número em texto por extenso (ex.: "um mil e quinhentos reais").

`;
