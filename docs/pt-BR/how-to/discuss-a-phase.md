# Como discutir uma fase

**Objetivo:** Reunir as decisões de implementação que uma fase precisa antes do planejamento começar — para que o pesquisador e o planejador possam agir sem precisar consultar você novamente.

**Pré-requisitos:** `.planning/ROADMAP.md` deve existir. Caso contrário, execute `/gsd-new-project` primeiro.

---

## Escolha seu modo de discussão

GSD Core oferece dois modos. Escolha com base em quão bem compreendida é a base de código.

**Se você quiser expressar suas preferências de implementação antecipadamente** (modo de entrevista, padrão):

```bash
/gsd-discuss-phase 2
```

Claude identifica áreas cinzentas no escopo da fase, permite que você selecione quais discutir e trabalha com aproximadamente quatro perguntas por área.

**Se a base de código já tem padrões claros e você acha a maioria das perguntas óbvias** (modo de suposições):

```bash
node gsd-tools.cjs config-set workflow.discuss_mode assumptions
/gsd-discuss-phase 2
```

Claude lê de 5 a 15 arquivos relevantes da base de código por meio de um subagente, formula suposições com evidências e níveis de confiança, e as apresenta para confirmação ou correção. Normalmente 2 a 4 interações em vez de 15 a 20.

Para voltar ao modo anterior:

```bash
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

Veja [Modos de discussão explicados](../workflow-discuss-mode.md) para uma comparação completa, incluindo quando cada modo tende a economizar tempo.

---

## Discutir todas as áreas cinzentas sem a etapa de seleção

Por padrão, Claude apresenta as áreas cinzentas e pergunta quais você deseja cobrir. Se você quiser trabalhar em todas elas sem esse prompt de seleção:

```bash
/gsd-discuss-phase 2 --all
```

---

## Acelerar uma fase direta

**Se a fase é bem compreendida e você quer que Claude escolha os padrões recomendados sem fazer perguntas:**

```bash
/gsd-discuss-phase 3 --auto
```

Claude seleciona a resposta recomendada para cada pergunta e registra as escolhas. Use isso para fases em que as decisões são de baixo impacto ou já estão implícitas pelas fases anteriores.

**Se você tem restrições de sessão remota (sem menus TUI):**

```bash
/gsd-discuss-phase 2 --text
```

Todos os prompts são renderizados como listas numeradas em texto simples em vez de seletores interativos.

---

## Responder perguntas em grupos

Se você preferir responder várias perguntas de uma vez em vez de uma por uma:

```bash
/gsd-discuss-phase 2 --batch
```

Claude agrupa de 2 a 5 perguntas por turno.

---

## Adicionar análise de trade-offs a cada pergunta

Se você quiser uma tabela comparativa das opções antes de se comprometer:

```bash
/gsd-discuss-phase 2 --analyze
```

---

## Responder em massa a partir de um arquivo preparado

Se você tem um arquivo de respostas preparado e quer enviar todas as decisões em uma única passagem:

```bash
/gsd-discuss-phase 1 --power
```

---

## Visualizar as suposições de Claude antes de discutir

**Se você quiser ver o que Claude assumiria e faria antes de qualquer sessão interativa** — útil para validar o alinhamento antes de investir tempo em discussão:

```bash
/gsd-discuss-phase 3 --assumptions
```

Claude exibe suas suposições (com evidências da base de código e níveis de confiança) e encerra. Nenhum CONTEXT.md é escrito. Revise a saída e, se algo precisar de correção, execute uma sessão normal de discussão ou em modo de suposições.

---

## O que o CONTEXT.md contém

Tanto o modo de discussão quanto o modo de suposições produzem o mesmo `{phase}-CONTEXT.md` no diretório da fase. Os agentes downstream (pesquisador, planejador, verificador de plano) leem esse arquivo de forma idêntica independentemente do modo que o produziu. Ele contém seis seções:

| Seção | Finalidade |
|---|---|
| `<domain>` | Delimitação da fase — o que esta fase entrega |
| `<decisions>` | Decisões de implementação confirmadas durante a sessão |
| `<canonical_refs>` | Especificações, ADRs e documentos que os agentes downstream devem ler |
| `<code_context>` | Recursos reutilizáveis, padrões e pontos de integração |
| `<specifics>` | Referências e preferências do usuário |
| `<deferred>` | Ideias anotadas para fases futuras |

A seção `<canonical_refs>` é obrigatória. Se você referenciar um documento, especificação ou ADR durante a discussão, Claude o adiciona imediatamente e o lê para embasar as perguntas subsequentes.

Veja [Esquema do CONTEXT.md](../reference/context-md.md) para a referência completa dos campos.

---

## Como as decisões alimentam o planejamento

Quando você executar `/gsd-plan-phase` em seguida, o planejador lê CONTEXT.md para saber quais decisões estão confirmadas. Ele não vai refazer perguntas já respondidas aqui. O pesquisador o lê primeiro para saber o que investigar.

**Se o CONTEXT.md estiver ausente quando você executar `/gsd-plan-phase`**, você terá a opção de continuar sem contexto (os planos usam apenas pesquisa e requisitos, sem suas preferências de design) ou executar `/gsd-discuss-phase` primeiro.

---

## Se você tiver um PRD ou documento de critérios de aceitação

Pule a fase de discussão completamente e vá direto para o planejamento:

```bash
/gsd-plan-phase 1 --prd path/to/prd.md
```

O planejador sintetiza o CONTEXT.md a partir do PRD e trata todos os requisitos como decisões confirmadas.

---

## Relacionados

- [Planejar uma fase](plan-a-phase.md)
- [Modos de discussão](../workflow-discuss-mode.md)
- [Esquema do CONTEXT.md](../reference/context-md.md)
- [Índice de documentação](../README.md)
