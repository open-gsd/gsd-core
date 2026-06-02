# Como fazer spike e sketch antes de se comprometer

**Objetivo:** Reduzir riscos de implementação por meio de experimentos de viabilidade focados (spikes) e exploração de direções visuais com maquetes HTML descartáveis (sketches) antes de se comprometer com uma fase em uma abordagem específica.

**Pré-requisitos:** Nenhum. `/gsd-spike` e `/gsd-sketch` criam seus próprios diretórios de armazenamento e não exigem um projeto GSD inicializado.

---

## Decida: spike, sketch ou ambos

| Você quer responder… | Use |
|---|---|
| "Essa abordagem técnica vai funcionar de verdade?" | `/gsd-spike` |
| "Este layout / interação / tratamento visual parece certo?" | `/gsd-sketch` |
| "Qual é a abordagem técnica correta e como ela deve parecer?" | Ambos, em ordem: spike primeiro, depois sketch |

Spikes respondem perguntas binárias de viabilidade com código executável e um veredicto VALIDATED / INVALIDATED / PARTIAL. Sketches respondem perguntas visuais com 2 a 3 variantes HTML comparáveis no navegador. Eles são complementares — um spike prova que a abordagem é construível, um sketch prova que o design vale a pena construir.

---

## Executar um spike

### Coleta interativa (padrão)

```bash
/gsd-spike
```

GSD pergunta sobre a questão técnica, a decompõe em 2 a 5 experimentos independentes estruturados como hipóteses **Given / When / Then**, e solicita confirmação antes de construir.

### Fornecer a ideia diretamente

```bash
/gsd-spike "can we stream LLM tokens through SSE"
```

### Pular a coleta e executar imediatamente

```bash
/gsd-spike --quick "websocket vs SSE latency"
```

`--quick` ignora a conversa de decomposição e trata o argumento como uma única pergunta de spike. Use isso quando a pergunta já for específica o suficiente para executar sem refinamento.

### O que cada experimento produz

Cada spike em `.planning/spikes/NNN-descriptive-name/` inclui:

- Código funcional (não pseudocódigo)
- Uma hipótese **Given / When / Then** escrita antes de qualquer código
- Um rastro de investigação documentando casos extremos, pivôs e surpresas
- Um veredicto **VALIDATED**, **INVALIDATED** ou **PARTIAL** com evidências
- Um `README.md` com frontmatter, instruções de como executar e resultados

Todos os spikes são indexados em `.planning/spikes/MANIFEST.md`.

### Empacotar os resultados

Quando você tiver um sinal, empacote os resultados em uma skill local do projeto para que sessões futuras os carreguem automaticamente:

```bash
/gsd-spike --wrap-up
```

Isso grava em `.claude/skills/spike-findings-[project]/`. A skill é descoberta automaticamente e carregada por execuções subsequentes de `/gsd-sketch`, `/gsd-ui-phase` e `/gsd-plan-phase` — você não precisa referenciá-la explicitamente.

---

## Executar um sketch

### Coleta de mood (padrão)

```bash
/gsd-sketch
```

GSD abre uma conversa breve para explorar sensação, referências visuais e a ação principal do usuário antes de qualquer código ser escrito. Faz uma pergunta por vez e só começa a construir quando você diz para ir.

### Fornecer uma direção de design diretamente

```bash
/gsd-sketch "dashboard layout"
```

### Pular a coleta de mood e executar imediatamente

```bash
/gsd-sketch --quick "sidebar navigation"
```

`--quick` ignora completamente a conversa de coleta e usa o argumento como direção de design.

### Runtimes não-Claude (Codex, Gemini CLI, etc.)

```bash
/gsd-sketch --text "onboarding flow"
```

`--text` substitui prompts interativos por listas numeradas em texto simples. Use isso quando seu runtime não suporta `AskUserQuestion`.

### O que cada sketch produz

Cada sketch em `.planning/sketches/NNN-descriptive-name/` inclui:

- `index.html` com 2 a 3 variantes acessíveis via navegação por abas — abra diretamente no navegador, sem etapa de build
- Elementos interativos funcionais (hover, clique, transições)
- Conteúdo realista usando nomes de campos e formatos de dados de qualquer resultado de spike anterior
- Variáveis CSS compartilhadas de `.planning/sketches/themes/default.css`
- Um `README.md` com a pergunta de design, variantes e o que observar

Todos os sketches são indexados em `.planning/sketches/MANIFEST.md`.

### Empacotar as decisões de design vencedoras

Após escolher uma variante, capture as decisões visuais em uma skill local do projeto:

```bash
/gsd-sketch --wrap-up
```

Isso grava em `.claude/skills/sketch-findings-[project]/`. A skill é carregada automaticamente por `/gsd-ui-phase` — decisões pré-validadas (layout, paleta de cores, tipografia, espaçamento) são tratadas como bloqueadas e não serão solicitadas novamente.

---

## Fluxo combinado: spike → sketch → fase

Esta é a sequência recomendada quando você está incerto tanto sobre a viabilidade técnica quanto sobre a direção visual:

```bash
/gsd-spike "SSE vs WebSocket for real-time feed"
/gsd-spike --wrap-up

/gsd-sketch "real-time feed UI"
/gsd-sketch --wrap-up

/gsd-discuss-phase N
/gsd-plan-phase N
```

Os resultados do spike informam o sketch (formatos de dados reais, estados de interação reais, restrições realistas). Ambos os wrap-ups persistem decisões que o planejador e o pesquisador de UI carregam automaticamente, portanto você não precisa re-explicar escolhas durante `/gsd-discuss-phase` ou `/gsd-ui-phase`.

---

## Como um spike ou sketch alimenta uma fase

Artefatos de spike e sketch não precisam ser referenciados manualmente. GSD os lê automaticamente em dois pontos:

1. **`/gsd-sketch`** — carrega `.claude/skills/spike-findings-*/` antes de construir maquetes, para que as variantes reflitam restrições comprovadas (estados de streaming, nomes de campos reais, etc.)
2. **`/gsd-ui-phase N`** — carrega `.claude/skills/sketch-findings-*/` antes de gerar o contrato de design de UI; decisões de design pré-validadas são tratadas como bloqueadas

O planejador também lê os resultados do spike quando uma skill `spike-findings-*` está presente, de modo que escolhas técnicas validadas (qual biblioteca, qual protocolo, qual formato de dados) fluem diretamente para os planos de tarefas sem explicação repetida.

---

## Relacionados

- [Projetar uma fase de UI](design-a-ui-phase.md)
- [Planejar uma fase](plan-a-phase.md)
- [Comandos](../COMMANDS.md)
- [Índice de documentação](../README.md)
