# Como conduzir o GSD Core a partir de uma issue do rastreador

**Objetivo:** Levar uma única issue bem delimitada do GitHub, Linear ou Jira por todo o pipeline do GSD — desde o workspace isolado até o PR mesclado — usando apenas comandos já existentes no GSD Core, sem scripts customizados ou integrações com rastreadores.

**Pré-requisitos:** GSD Core está instalado. A issue tem escopo delimitado, critérios de aceitação observáveis e nenhum bloqueador upstream.

Para os conceitos e a justificativa de design por trás desse padrão, consulte [Orquestração orientada a issues explicada](../issue-driven-orchestration.md).

---

## Passo 1: Mapear a issue para uma fase

Abra sua issue no rastreador e decida como ela se encaixa no `ROADMAP.md`:

- **A issue corresponde a uma fase existente** → anote o número da fase e avance para o Passo 2.
- **A issue é um trabalho novo independente** → adicione uma fase:

```bash
/gsd-phase "Descrição correspondente ao título da issue"
```

- **A issue é urgente e precisa ser inserida entre fases existentes** → insira uma fase decimal:

```bash
/gsd-phase --insert 3 "Fix: descrição da issue"
```

Copie a URL da issue do rastreador. Você irá colá-la no `CONTEXT.md` no Passo 3 para que a rastreabilidade sobreviva à compactação de contexto.

---

## Passo 2: Criar um workspace isolado

Cada issue recebe seu próprio workspace — um git worktree com um diretório `.planning/` independente. Trabalhos parciais, planos abandonados e commits exploratórios ficam fora do `main`.

```bash
/gsd-workspace --new --name my-issue-slug --repos . --strategy worktree
```

Entre no diretório do workspace antes de continuar:

```bash
cd ~/gsd-workspaces/my-issue-slug
```

---

## Passo 3: Discutir a fase

Execute discuss-phase para definir as decisões de implementação antes que qualquer planejamento aconteça. Quando a sessão abrir, cole a URL da issue do rastreador na discussão para que ela seja capturada no `CONTEXT.md`.

```bash
/gsd-discuss-phase N
```

O GSD pergunta sobre ambiguidades no escopo da issue — tratamento de erros, casos extremos, contratos de interface, escolhas tecnológicas. Suas respostas moldam o plano que se segue.

Se você já sabe todas as respostas e quer avançar rapidamente:

```bash
/gsd-discuss-phase N --auto
```

---

## Passo 4: Planejar a fase

```bash
/gsd-plan-phase N
```

O GSD cria agentes de pesquisa, lê suas decisões do `CONTEXT.md` (incluindo a URL da issue) e produz arquivos `PLAN.md` atômicos. Um verificador de planos valida cada plano antes de salvá-lo.

Se você quiser revisão por pares de CLIs externas de IA antes da execução (recomendado para mudanças significativas):

```bash
/gsd-review --phase N
/gsd-plan-phase N --reviews
```

Ou execute o loop completo de planejar–revisar–convergir até que não haja mais preocupações de nível HIGH:

```bash
/gsd-plan-review-convergence N
```

---

## Passo 5: Executar a fase

Para execução interativa, fase por fase:

```bash
/gsd-execute-phase N
```

Para uma execução sem supervisão por todas as fases restantes:

```bash
/gsd-autonomous
```

Para um painel interativo onde você pode acompanhar o progresso e despachar trabalho entre fases:

```bash
/gsd-manager
```

As três abordagens atualizam o `STATE.md`, fazem commit de cada tarefa atomicamente e executam o verificador pós-fase.

---

## Passo 6: Verificar o trabalho

```bash
/gsd-verify-work N
```

O GSD percorre os critérios de aceitação do objetivo da fase (que reflete sua issue do rastreador) um de cada vez. Se algo falhar, o GSD diagnostica a causa raiz e cria um plano de correção. Execute novamente e re-verifique até que todas as verificações passem.

Trate `verification_failed` como um bloqueador mesmo quando o código parece correto — a falha geralmente revela um critério de aceitação não atendido da issue original.

---

## Passo 7: Revisar e publicar

Execute uma revisão de código antes de abrir o PR:

```bash
/gsd-code-review N
/gsd-code-review N --fix
```

Em seguida, crie o PR:

```bash
/gsd-ship N
```

O GSD monta o corpo do PR a partir dos seus artefatos de planejamento: objetivo da fase, resumo das mudanças, requisitos atendidos, status de verificação e decisões-chave. Inclua `Closes #NNN` ou `Fixes #NNN` no corpo do PR (ou configure via `/gsd-config`) para que a issue do rastreador seja fechada automaticamente quando o PR for mesclado.

---

## Passo 8: Registrar trabalho de acompanhamento

Ao trabalhar na issue, você frequentemente descobrirá trabalhos relacionados. Registre-os sem perder o contexto:

```bash
/gsd-capture "Acompanhamento: descrição do trabalho descoberto"      # Adicionar como tarefa
/gsd-capture --seed "Ideia que vale uma fase futura"                 # Preservar para o próximo milestone
/gsd-capture --backlog "Não urgente, mas vale registrar"             # Arquivar no backlog
```

O GSD não publica no seu rastreador automaticamente. Criar uma issue no rastreador a partir dos acompanhamentos registrados é uma etapa manual separada — isso mantém a revisão humana no ciclo.

---

## Condicionais

| Situação | O que fazer |
|-----------|-----------|
| A issue é muito pequena (typo, mudança de config) | Pule workspace + discuss + plan; use `/gsd-quick` em vez disso |
| A issue tem múltiplas subtarefas independentes | Use `/gsd-manager` para paralelizar a execução entre planos |
| A issue está bloqueada em outra issue | Não inicie até que o bloqueador upstream seja resolvido; o GSD não possui poller automático de dependências |
| O escopo da issue se mostra maior do que o esperado durante a execução | Pare, execute `/gsd-phase --insert N` para adicionar subfases, continue |
| Você quer pular a discussão interativa | Use a flag `--auto` com `/gsd-discuss-phase`, ou defina `workflow.skip_discuss: true` para automação em todo o projeto |
| Múltiplas issues formam uma release coerente | Execute `/gsd-new-milestone` para agrupá-las e `/gsd-autonomous` para executar em sequência |

---

## Relacionados

- [Orquestração orientada a issues explicada](../issue-driven-orchestration.md)
- [Isolar trabalho com workspaces](isolate-work-with-workspaces.md)
- [Verificar e publicar](verify-and-ship.md)
- [índice de documentação](../README.md)
