# Modo Discuss: Suposições vs Entrevista

A fase de discuss do GSD Core oferece dois modos para coletar o contexto de implementação antes do início do planejamento. Entender quando usar cada um ajuda a passar da fase de perguntas para um `CONTEXT.md` confirmado com menos idas e vindas.

Para instruções passo a passo sobre como executar cada modo, consulte o [Como realizar discuss de uma fase](how-to/discuss-a-phase.md).

## Modos

### `discuss` (padrão)

O fluxo original no estilo de entrevista. O Claude identifica áreas cinzentas na fase, apresenta-as para seleção e faz aproximadamente quatro perguntas por área. Adequado para:

- Fases iniciais em que o código-base é novo
- Fases em que o usuário tem opiniões firmes que deseja expressar proativamente
- Usuários que preferem coleta de contexto guiada e conversacional

### `assumptions`

Um fluxo com foco no código-base. O Claude analisa profundamente o código-base por meio de um subagente (lendo de 5 a 15 arquivos relevantes), formula suposições com evidências e as apresenta para confirmação ou correção. Adequado para:

- Código-bases consolidados com padrões bem definidos
- Usuários que consideram as perguntas da entrevista óbvias
- Coleta de contexto mais rápida (~2–4 interações vs ~15–20)

## Configuração

```bash
# Habilitar o modo assumptions
node gsd-tools.cjs config-set workflow.discuss_mode assumptions

# Voltar ao modo de entrevista
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

A configuração é por projeto (armazenada em `.planning/config.json`). Consulte o [esquema do CONTEXT.md](reference/context-md.md) para ver a estrutura completa do arquivo produzido por ambos os modos.

## Como o Modo Assumptions Funciona

1. **Inicialização** — Igual ao modo discuss (carrega contexto anterior, explora o código-base, verifica pendências)
2. **Análise aprofundada** — O subagente de exploração lê de 5 a 15 arquivos do código-base relacionados à fase
3. **Apresentação das suposições** — Cada suposição inclui:
   - O que o Claude faria e por quê (citando caminhos de arquivo)
   - O que dá errado se a suposição estiver incorreta
   - Nível de confiança (Confident / Likely / Unclear)
4. **Confirmar ou corrigir** — O usuário revisa as suposições e seleciona as que precisam ser alteradas
5. **Escrever o CONTEXT.md** — Formato de saída idêntico ao do modo discuss

## Compatibilidade de Flags

| Flag | modo `discuss` | modo `assumptions` |
|------|----------------|-------------------|
| `--auto` | Seleciona automaticamente as respostas recomendadas | Ignora a etapa de confirmação e resolve automaticamente itens Unclear |
| `--batch` | Agrupa perguntas em lotes | N/A (correções já agrupadas) |
| `--text` | Perguntas em texto puro (sessões remotas) | Perguntas em texto puro (sessões remotas) |
| `--analyze` | Exibe tabelas de trade-off por pergunta | N/A (suposições já incluem evidências) |

## Saída

Ambos os modos produzem um `CONTEXT.md` idêntico com as mesmas seis seções:

- `<domain>` — Limite da fase
- `<decisions>` — Decisões de implementação confirmadas
- `<canonical_refs>` — Especificações/documentos que os agentes downstream devem ler
- `<code_context>` — Ativos reutilizáveis, padrões, pontos de integração
- `<specifics>` — Referências e preferências do usuário
- `<deferred>` — Ideias registradas para fases futuras

Os agentes downstream (researcher, planner, checker) consomem esse arquivo de forma idêntica, independentemente do modo que o produziu. Consulte o [esquema do CONTEXT.md](reference/context-md.md) para a referência completa dos campos.

## Relacionados

- [Realizar discuss de uma fase](how-to/discuss-a-phase.md) — passo a passo para executar `/gsd-discuss-phase` em qualquer modo.
- [Esquema do CONTEXT.md](reference/context-md.md) — referência completa dos campos do arquivo produzido por ambos os modos.
- [O ciclo de fases](explanation/the-phase-loop.md) — como o discuss se encaixa no ciclo mais amplo de discuss → plan → execute → verify → ship.
- [Índice de documentação](README.md) — sumário completo da documentação do GSD Core.
