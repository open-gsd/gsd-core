# Como executar fases de forma autônoma

Execute todas as fases restantes — ou um intervalo delimitado delas — sem supervisão, para que o GSD avance por discuss → plan → execute em cada fase sem que você precise conduzir cada etapa.

Para mais informações sobre o que o loop de fases faz durante uma execução autônoma, consulte [O loop de fases](../explanation/the-phase-loop.md).

---

## Pré-requisitos

- Um projeto ativo com `.planning/ROADMAP.md` e `.planning/STATE.md`
- Todas as fases que você deseja executar devem estar em um estado que o modo autônomo possa conduzir (pendente ou em andamento; não já concluídas)
- Qualquer decisão de design que você se importe já deve estar em `PROJECT.md` ou registrada via um `/gsd-discuss-phase` anterior — o modo autônomo só consegue apresentar áreas cinzentas de forma interativa quando você usa `--interactive`

---

## Executar todas as fases restantes

```bash
/gsd-autonomous
```

O GSD lê o `ROADMAP.md`, descobre cada fase incompleta em ordem numérica e executa discuss → plan → execute em cada uma. Após todas as fases serem concluídas, ele executa automaticamente o ciclo de vida do milestone: audit → complete → cleanup.

---

## Executar um intervalo específico de fases

Use `--from` e `--to` para delimitar a execução. Ambos os flags aceitam números de fase decimais (ex.: `3.1`).

```bash
/gsd-autonomous --from 3          # fases 3, 4, 5 … (ignora as fases 1 e 2 já concluídas)
/gsd-autonomous --to 5            # fases até e incluindo a 5
/gsd-autonomous --from 3 --to 5   # exatamente as fases 3, 4 e 5
```

Quando `--to` é atingido, a etapa de ciclo de vida é ignorada, pois nem todas as fases do milestone foram concluídas. O banner de conclusão informa como retomar:

```text
Resume with: /gsd-autonomous --from 6
```

---

## Executar com discuss interativo

Por padrão, o modo autônomo responde às perguntas de discuss automaticamente usando o smart discuss (propostas em tabela em lote). Se você quiser responder às perguntas de design você mesmo, mantendo plan e execute fora do contexto principal:

```bash
/gsd-autonomous --interactive
```

No modo interativo:
- `/gsd-discuss-phase` é executado inline e aguarda suas respostas
- Planejamento e execução são despachados como agentes em segundo plano para que você possa discutir a próxima fase enquanto a atual está sendo construída
- O contexto principal permanece enxuto — apenas as conversas de discuss se acumulam

---

## Quais barreiras de segurança ainda se aplicam

O modo autônomo não ignora o pipeline de qualidade do GSD. Cada fase ainda:

- Executa o plan-checker antes da execução
- Lê o `VERIFICATION.md` após a execução e decide o caminho com base no resultado
- Pausa e pergunta o que fazer quando o status de verificação é `human_needed` ou `gaps_found`
- Para e apresenta opções (corrigir e tentar novamente, ignorar fase ou parar) se alguma etapa falhar

A única diferença em relação à execução manual é que a verificação com resultado `passed` avança automaticamente — você não é questionado entre as fases a menos que uma decisão seja necessária.

A barreira de legitimidade de pacotes também permanece ativa. Se um plano incluir uma tarefa `checkpoint:human-verify` para um pacote suspeito, o executor irá parar e apresentar o checkpoint. O modo autônomo não instalará silenciosamente pacotes sinalizados.

---

## Quando não usar o modo autônomo

Não use `/gsd-autonomous` quando:

- **As fases têm decisões de design não resolvidas.** Se você não executou `/gsd-discuss-phase` e seu `PROJECT.md` não registra suas preferências, o smart discuss fará escolhas autônomas com as quais você pode não concordar. Execute o discuss de forma interativa primeiro, ou use `--interactive`.

- **Você precisa de controle detalhado sobre uma única fase.** Para uma fase, `/gsd-execute-phase N` fornece saída passo a passo e permite que você reaja antes de continuar. O modo autônomo é projetado para execuções em lote sem supervisão.

- **A fase tem trabalho novo ou de alto risco.** O modo autônomo ignora pausas a menos que encontre um bloqueador. Em uma fase onde você espera surpresas, mantenha-se no loop com execução manual.

- **Você está no meio de uma fase com execução parcial.** O modo autônomo retoma fases incompletas, mas não retoma uma onda parcialmente executada. Use `/gsd-execute-phase N` para concluir uma fase que já está em andamento.

Se uma execução parar no meio do caminho, consulte [Depurar uma execução com falha](debug-a-failed-execution.md) para saber como diagnosticar o que deu errado.

---

## Verificar o progresso durante uma execução

O modo autônomo exibe um banner de progresso antes de cada fase:

```text
 GSD ► AUTONOMOUS ▸ Phase 3/7: Auth Middleware [████░░░░] 28%
```

Se você precisar verificar onde a execução está no meio da sessão, abra outro terminal e execute:

```bash
/gsd-progress
```

---

## Retomar após uma parada

Se o modo autônomo parar — seja porque você escolheu "Stop autonomous mode" no prompt de bloqueio, ou a sessão foi interrompida — retome de onde parou:

```bash
/gsd-autonomous --from 4     # substitua 4 pelo número da primeira fase incompleta
```

O GSD ignora automaticamente as fases já concluídas, portanto é seguro executar novamente a partir de um número de fase anterior caso não tenha certeza de onde a execução parou.

---

## Relacionados

- [Executar uma fase](execute-a-phase.md)
- [Depurar uma execução com falha](debug-a-failed-execution.md)
- [Comandos](../COMMANDS.md)
- [Índice da documentação](../README.md)
