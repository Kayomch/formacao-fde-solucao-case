# Wireframe do bloco "Pedido ao fornecedor" (#156, entrega 4 de 5)

Receber parcial (E1, E2, E3), `request_type = return_note`. Rodada 1. **Aprovado por: a pessoa dona do design, em 15/11/2026, como desenhado, com as recomendações das nove perguntas em aberto. A pergunta 8 (número ND e nome do anexo só depois de emitir) se afasta de propósito do wireframe ASCII da issue.** O mesmo conteúdo, com as larguras lado a lado, está em `index.html`.

## Onde o bloco fica

Último item da gaveta (`ProposalPanel`, 530 px no desktop, largura da tela no celular): depois do dossiê, da linha do tempo e do Alert "Decisão registrada".

## Quando não aparece

- Proposta ainda não decidida (formulário "Sua decisão" no lugar).
- Decisão sem devolução: receber, recusar, ou receber parcial em que toda linha ficou em "segurar".
- Classificação E7 ou match (sem e-mail, sem nota); classificação fora de E1, E2 e E3 (backlog).
- Proposta alterada pela pessoa para um tipo sem devolução: o bloco não aparece, mesmo que a proposta do sistema tivesse devolução.

## S0 · Não aparece

**Quando:** A proposta não está decidida (a gaveta mostra o formulário "Sua decisão"); a decisão não devolve nada (receber, recusar, ou receber parcial com todas as linhas em "segurar"); a classificação é E7 ou match; a classificação não é E1, E2 nem E3.

**O que mostra:** Nada. Nenhum título, nenhum espaço vazio: a gaveta termina no Alert "Decisão registrada" como hoje.


## S1 · Carregando o pedido

**Quando:** A gaveta abriu, a proposta está decidida com devolução e a leitura do pedido ao fornecedor ainda não voltou.

**O que mostra:** O título do bloco e a linha "Carregando o pedido ao fornecedor…" no mesmo InlineEmpty que a gaveta usa. O resto da gaveta não espera por ele.


## S2 · Erro ao carregar o pedido

**Quando:** A leitura do pedido falhou (rede ou 5xx). Um 404 não é erro: é "ainda sem pedido" (S3).

**O que mostra:** Alert de erro com o que aconteceu e "Tentar de novo". Não bloqueia o resto da gaveta; a decisão já registrada continua valendo.


## S3 · Escrevendo (Claude)

**Quando:** A decisão com devolução existe e o Cron seguinte ainda não escreveu o rascunho (ou a pessoa pediu "Refazer").

**O que mostra:** O mesmo estado de IA do dossiê (Alert info, selo ✦ Claude): "O Claude está preparando o pedido…", mais a linha de quando sai. Sem botões: não há o que a pessoa fazer. Não há polling: a pessoa reabre a gaveta (ver pergunta 6).


## S4 · Rascunho

**Quando:** O Cron escreveu o rascunho, o verificador de números aprovou, nada foi emitido (AC-1, AC-3).

**O que mostra:** Nota de devolução (travada) + e-mail (para, prazo, assunto, corpo) + "O que pedimos" (travado) + anexo + três botões. Emitir e enviar é o botão primário; Descartar é discreto. No celular: o item da nota quebra em duas linhas (nome acima, conta abaixo), os botões empilham com Emitir e enviar no topo.

```
┌──────────────────────────────────────────────────────────┐
│ Pedido ao fornecedor                         [✦ Claude]  │
│                                                          │
│ Nota de devolução (rascunho) 🔒                           │
│   Para: Higiene Lume Indústria Ltda. (F04) · Ref.: NF 47941 · CD-01 │
│   Shampoo 350 ml  376 UN × R$ 16,90 = R$ 6.354,40        │
│   Total da devolução                    R$ 6.354,40      │
│   Número da nota: definido ao emitir.                    │
│                                                          │
│ E-mail                                                   │
│   Para: fiscal@higienelume.test · Prazo: 19/11           │
│   Assunto: NF 47941 · devolução do item trocado 🔒        │
│   ┌ Corpo (a única parte editável) ───────────────────┐  │
│   │ Olá, equipe da Higiene Lume.                      │  │
│   │ Na NF 47941 veio Shampoo 350 ml (376 UN,          │  │
│   │ R$ 6.354,40) no lugar do Sabonete em barra 85 g.  │  │
│   │ Segue a nota de devolução. Pedimos a retirada do  │  │
│   │ Shampoo e a entrega do Sabonete (2.548 UN).       │  │
│   └───────────────────────────────────────────────────┘  │
│   O que pedimos 🔒                                        │
│    1. Retirar o Shampoo 350 ml (376 UN) da NF 47941.     │
│    2. Entregar o Sabonete em barra 85 g (2.548 UN).      │
│   📎 nota-de-devolucao.json (gerada ao emitir)            │
│                                                          │
│ [ Descartar ]        [ Editar ]   [ Emitir e enviar ]    │
└──────────────────────────────────────────────────────────┘
```

Celular (360 px): a linha do item e as linhas "Para"/"Prazo" quebram em duas (rótulo acima, valor abaixo); os botões empilham, com Emitir e enviar no topo e Descartar por último.


## S5 · Editando o texto

**Quando:** A pessoa clicou em "Editar" no rascunho (AC-7).

**O que mostra:** Só o corpo vira campo de texto, com as marcas {{...}} do catálogo visíveis. Assunto, destinatário, prazo, nota, itens e "O que pedimos" ficam como estão, cada um com o selo 🔒. Salvar e Cancelar substituem os três botões: Emitir e enviar some até salvar ou cancelar, para a pessoa não emitir um texto não salvo.


## S5b · Editando: texto recusado

**Quando:** Ao salvar, o verificador achou um número que não bate com o banco (AC-6 aplicado à edição).

**O que mostra:** O campo fica aberto com o texto da pessoa, o erro vem logo abaixo dele, e Salvar continua disponível para tentar de novo. O rascunho gravado não muda.


## S6 · Emitindo e enviando

**Quando:** A pessoa clicou em "Emitir e enviar" e a resposta não voltou (AC-3, AC-4).

**O que mostra:** O rascunho fica como está, todos os botões desabilitados e o primário ocupado ("Emitindo e enviando…"). Uma região role="status" anuncia o andamento. Nada de modal.


## S7 · Emitida e enviada

**Quando:** A nota foi emitida e o e-mail saiu (AC-4, AC-5).

**O que mostra:** Alert de sucesso "Nota de devolução ND-0012 emitida e enviada por você às 10h40 · aguardando resposta até 19/11", e abaixo a nota emitida e o e-mail, sem botão de ação (leitura). A nota tem o link para o documento emitido (JSON; PDF na entrega 5).


## S8 · Emitida, envio falhou

**Quando:** A nota foi emitida (número gravado), mas o envio do e-mail falhou (status send_failed).

**O que mostra:** Alert de erro que diz as duas coisas, nessa ordem: a nota foi emitida, o e-mail não saiu, e o motivo. Um botão: "Tentar enviar de novo", que reenvia o mesmo e-mail e não emite outra nota (AC-4). Não há Descartar: a nota já existe.


## S9 · Reenviando

**Quando:** A pessoa clicou em "Tentar enviar de novo".

**O que mostra:** Igual a S8, com o botão ocupado ("Enviando…") e desabilitado. O Alert de erro continua até a resposta.


## S10 · Descartado por você

**Quando:** A pessoa clicou em "Descartar" no rascunho.

**O que mostra:** Alert neutro "Pedido descartado por você às 10h41" e o botão "Refazer". O texto do rascunho descartado não aparece (fica no banco, para auditoria). Nada foi emitido nem enviado.


## S11 · Rascunho descartado pelo verificador

**Quando:** O texto do Claude trazia um número fora do catálogo de fatos e o sistema descartou o rascunho, registrando o motivo (AC-6).

**O que mostra:** Alert de aviso com o motivo em português, sem repetir o texto descartado, e "Refazer". É diferente de S10: quem descartou foi o sistema, e a mensagem diz isso.


## S12 · Falha ao emitir

**Quando:** A emissão falhou (a resposta traz erro, nada foi gravado).

**O que mostra:** O rascunho volta para S4, com um Alert de erro acima dele: "Não consegui emitir a nota. Nada foi emitido nem enviado. Tente de novo." Os três botões voltam. Um 409 (outra pessoa emitiu antes) mostra "Este pedido já foi tratado por outra pessoa" e recarrega o bloco.


## S13 · Sem nível para emitir (só leitura)

**Quando:** A pessoa pode ver a proposta mas não tem o nível que a decide (canApprove falso), com o pedido em rascunho.

**O que mostra:** Proposta: o bloco aparece, só para leitura, com a nota e o e-mail do rascunho. Os botões são trocados por uma linha: "Só quem tem nível Gerente emite e envia este pedido" (mesmo padrão do Alert "needsLevel"). Nos estados S7, S8 e S10 a leitura é igual para todos; o botão "Tentar enviar de novo" e "Refazer" também somem sem o nível.


## Fluxo

```
            (decisão com devolução registrada)
                         │
                         ▼
                 ┌──────────────┐  erro de rede   ┌────────────────────┐
                 │ S1 Carregando│────────────────▶│ S2 Erro ao carregar│
                 └──────┬───────┘◀── Tentar de novo└────────────────────┘
                        │ sem pedido ainda (404)
                        ▼
                 ┌──────────────┐ Cron escreve e o verificador aprova
                 │ S3 Escrevendo│───────────────────────────┐
                 └──────┬───────┘                           │
        verificador     │ Cron escreve, número fora         ▼
        reprova         │ do catálogo (AC-6)       ┌──────────────────┐◀─────────────────┐
                        ▼                          │   S4 Rascunho    │                  │
          ┌────────────────────────┐   Refazer     └─┬────┬───────┬───┘ Salvar texto /   │
          │ S11 Descartado pelo    │──────▶ S3       │    │Editar │     Cancelar         │
          │ verificador            │                 │    │       ▼                      │
          └────────────────────────┘                 │    │  ┌────────────────┐          │
                                                     │    │  │ S5 Editando    │──────────┘
                                   Descartar         │    │  │ (S5b: recusado)│
                ┌────────────────────────────────────┘    │  └────────────────┘
                ▼                                         │ Emitir e enviar
      ┌──────────────────┐   Refazer ──▶ S3               ▼
      │ S10 Descartado   │                        ┌──────────────────┐ falha ao emitir ┌──────────────┐
      │ por você         │                        │ S6 Emitindo e    │────────────────▶│ S12 Falha    │
      └──────────────────┘                        │ enviando         │                 │ (volta S4)   │
                                                  └───┬──────────┬───┘                 └──────────────┘
                                         emitiu e     │          │ emitiu, e-mail falhou
                                         enviou       ▼          ▼
                                  ┌──────────────────┐   ┌─────────────────────┐
                                  │ S7 Emitida e     │   │ S8 Emitida, envio   │◀──┐
                                  │ enviada (fim)    │◀──│ falhou              │   │ falhou de novo
                                  └──────────────────┘   └─────────┬───────────┘   │
                                         enviou de novo            │ Tentar enviar │
                                                                   ▼ de novo       │
                                                         ┌──────────────────┐──────┘
                                                         │ S9 Reenviando    │
                                                         └──────────────────┘
S13 (sem nível) é o mesmo bloco em leitura: não é um estado do fluxo, é um modo de qualquer estado.
```

| De | Clique ou evento | Para |
|---|---|---|
| (decisão registrada) | abrir a gaveta | S1 Carregando |
| S1 | pedido lido: nenhum ainda | S3 Escrevendo |
| S1 | pedido lido: rascunho / emitido / descartado | S4 / S7 / S8 / S10 / S11, conforme o status |
| S1 | leitura falhou | S2 Erro ao carregar |
| S2 | clique em Tentar de novo | S1 |
| S3 | Cron escreve o rascunho e o verificador aprova (próxima abertura da gaveta) | S4 Rascunho |
| S3 | Cron escreve e o verificador reprova (AC-6) | S11 |
| S4 | Editar | S5 Editando |
| S5 | Salvar texto (válido) | S4 com o texto novo |
| S5 | Salvar texto (número fora do catálogo) | S5b, texto da pessoa mantido |
| S5 / S5b | Cancelar | S4 com o texto anterior |
| S4 | Descartar | S10 Descartado por você |
| S4 | Emitir e enviar | S6 Emitindo e enviando |
| S6 | emitiu e enviou | S7 Emitida e enviada |
| S6 | emitiu, o envio falhou | S8 |
| S6 | a emissão falhou | S12, que mostra S4 com o aviso |
| S8 | Tentar enviar de novo | S9 Reenviando |
| S9 | enviou | S7 |
| S9 | falhou de novo | S8 |
| S10 / S11 | Refazer | S3 Escrevendo (o Cron seguinte escreve) |


## Perguntas em aberto

**1. "Descartar" pede confirmação?**
Recomendação: Não. Nada foi emitido nem enviado, e "Refazer" desfaz o descarte. Um modal a mais custaria um clique em todo descarte para evitar um dano que não existe. Descartar fica como botão discreto (ghost) e longe do primário.

**2. "Refazer" gera o novo rascunho no clique ou no Cron seguinte?**
Recomendação: No Cron seguinte, como o plano aprovado diz ("o rascunho sai na rodada do Cron seguinte, não no clique"). O clique só marca o pedido como pendente e o bloco volta a S3 com a linha "sai na próxima rodada". Gerar no clique pediria chamar o Claude dentro da requisição, o que o plano evita.

**3. A lista do que pedimos aparece no rascunho?**
Recomendação: Sim, como lista numerada e travada (🔒) abaixo do corpo. É o que o fornecedor tem de fazer, item a item, e a regra é quem a monta (AC-7): a pessoa vê o que está pedindo mesmo editando só o texto. A issue não a desenha; é um acréscimo meu ao wireframe dela.

**4. O que mostrar no anexo antes da entrega 5 (PDF)?**
Recomendação: A linha existe, com o nome e o estado do que realmente vai: "nota-de-devolucao.json (gerada ao emitir)", e depois de emitir "nota-devolucao-ND-0012.json · abrir". Na entrega 5 o nome troca para .pdf sem mudar a estrutura. Não desenhar um PDF que o sistema ainda não gera.

**5. Quem sem nível vê o bloco, e como?**
Recomendação: Quem lê a proposta vê o bloco em leitura (S13), sem botões, com a mesma linha de nível que a gaveta usa no formulário. Esconder o bloco faria o leitor achar que não há pedido. Recomendo que emitir, descartar, editar, refazer e reenviar sigam o mesmo nível que decide a proposta (canApprove).

**6. A gaveta atualiza sozinha de "Escrevendo" para o rascunho?**
Recomendação: Não: sem polling. O Cron roda a intervalos e a gaveta lê ao abrir; o texto de S3 diz que o rascunho sai na próxima rodada, e a pessoa reabre a gaveta. Um "Atualizar" no S3 é aceitável se o dono quiser, mas fica fora do desenho.

**7. O assunto é editável?**
Recomendação: Não, só o corpo (AC-7: "só o texto do e-mail"). O assunto leva o número da nota de origem, que é um número travado; o destinatário e o prazo também. Se o dono quiser editar o assunto, ele passa a ter marcas {{...}} como o corpo.

**8. O número da nota (ND-0012) aparece no rascunho?**
Recomendação: Não. O número só nasce ao emitir (a reserva está no emissor, ADR-003), então o rascunho diz "Número da nota: definido ao emitir". Contradigo o wireframe da issue, que mostra ND-0012 e o PDF já nomeado no rascunho, porque o número ainda não existe nesse ponto.

**9. "Tentar enviar de novo" tem limite?**
Recomendação: Sem limite de cliques, mas o botão fica ocupado até a resposta (S9). O reenvio não emite outra nota (AC-4).


## Fonte dos dados fictícios

- Nota: data/kit/notas.json, NF-013 (número 47941, chave 35261100023027000111550010000479411353478484, destino CD-01, emitida em 2026-11-10). A nota traz Shampoo 350 ml (376 UN × R$ 16,90 = R$ 6.354,40) no lugar do Sabonete em barra 85 g da ordem OC (data/kit/ordens.json, 2.548 UN); classificação E2.
- Fornecedor: data/kit/fornecedores.json, F04, Higiene Lume Indústria Ltda.
- Inventado, e marcado como tal: o e-mail fiscal@higienelume.test (o kit ainda não tem e-mail; a issue diz que o kit ganha um de teste por fornecedor), o número ND-0012 (da issue), as horas 10h40 e 10h41, e o prazo 19/11 (3 dias úteis a partir da emissão em 16/11, a segunda-feira seguinte a hoje).
