# YouTube Live Chat Overlay

Overlay de chat ao vivo do YouTube para usar no OBS Studio. Exibe mensagens com avatar, nome colorido por função e texto - igual ao chat do YouTube, mas estilizado para stream.

**Cores:**
- 🔴 **Vermelho** - espectadores comuns
- 🔵 **Azul** - moderadores
- 🟢 **Verde** - membros do canal

## O que não consegui fazer:
- Mensagens que foram retiradas pelo automod e voltaram aparecerem
- Emojis do Youtube e membros aparecerem

---

## Requisitos

- [Node.js](https://nodejs.org) (versão 18 ou superior - baixe a versão LTS)
- OBS Studio (qualquer versão recente)

---

## Instalação

**1. Baixe ou clone o projeto**

Se tiver Git instalado:
```
git clone https://github.com/emilia-gomes2008/chat.git
```

Ou baixe o ZIP pelo GitHub e extraia a pasta.

**2. Instale as dependências**

Abra o terminal dentro da pasta do projeto e execute:
```
npm install
```

Isso instala tudo automaticamente. Só precisa fazer isso uma vez.

---

## Como usar

**1. Inicie o servidor**

No terminal, dentro da pasta do projeto:
```
npm start
```

Você verá a mensagem:
```
YouTube Live Chat overlay: http://localhost:3000
```

Deixe o terminal aberto enquanto estiver transmitindo.

**2. Configure o overlay**

Abra o navegador em `http://localhost:3000`.

Você verá a tela de configuração:

- Escolha o tipo de ID:
  - **Channel ID** - o ID do seu canal (começa com `UC`, ex: `UCxxxxxxxxxxxxxxxx`). O sistema encontra a live automaticamente.
  - **Video / Live ID** - o ID de um vídeo específico (aparece na URL da live, ex: `dQw4w9WgXcQ`).
- Cole o ID no campo e clique em **Generate OBS URL**.
- Copie a URL gerada.

**Como encontrar seu Channel ID:**
1. Acesse seu canal no YouTube
2. Clique em **Personalizar canal** → **Informações básicas**
3. Role até "ID do canal" - começa com `UC`

**3. Adicione no OBS**

1. No OBS, clique em **+** na lista de Fontes
2. Escolha **Navegador** (Browser Source)
3. Cole a URL copiada no campo **URL**
4. Configure o tamanho: **Largura 1920 × Altura 1080** (ou o tamanho da sua cena)
5. **Importante:** desmarque a opção *"Atualizar navegador quando a cena ficar ativa"* - isso evita que o chat reinicie ao trocar de cena
6. Clique em OK

---

## Por que o chat não para ao trocar de cena?

A maioria dos overlays de chat para porque roda completamente no navegador. Quando o OBS desativa a fonte ao trocar de cena, o navegador perde a conexão com o YouTube e precisa reconectar do zero.

Neste projeto:

- A **conexão com o YouTube fica no servidor Node.js**, que roda separado do OBS
- O OBS só exibe a interface - se o navegador cair, ele se **reconecta automaticamente** ao servidor local
- O servidor tem **reconexão automática** com o YouTube: se a live cair ou a internet falhar, ele tenta novamente em intervalos crescentes (5 s, 10 s, 20 s… até 60 s)

---

## Solução de problemas

| Problema | Solução |
|---|---|
| "npm não é reconhecido" | Instale o Node.js em [nodejs.org](https://nodejs.org) e reinicie o terminal |
| Chat não aparece | Verifique se o canal está ao vivo no momento |
| Avatares não carregam | Normal em alguns canais - o nome e a mensagem ainda aparecem |
| Chat parou de atualizar | O servidor reconecta sozinho. Veja o terminal para acompanhar o status |
| Porta 3000 ocupada | Feche outros programas usando a porta 3000, ou altere o número no final do `server.js` |

---

## Personalização

### Número máximo de mensagens visíveis

No arquivo [public/chat.js](public/chat.js), linha 4:
```js
const MAX_MESSAGES = 30; // altere para o número que quiser
```

### Cores dos nomes

No arquivo [public/style.css](public/style.css):
```css
.message.chatter .name { background: #dd2222; } /* vermelho */
.message.mod     .name { background: #1a5fff; } /* azul */
.message.member  .name { background: #1a9e45; } /* verde */
```

### Tamanho da fonte

No arquivo [public/style.css](public/style.css), procure por `.name` e `.text` e altere o valor de `font-size`.

---

## Estrutura do projeto

```
├── server.js          # Servidor Node.js (conecta ao YouTube e distribui o chat)
├── package.json       # Dependências do projeto
└── public/
    ├── index.html     # Tela de configuração + overlay
    ├── style.css      # Estilo visual do chat
    └── chat.js        # Lógica do cliente (WebSocket + renderização)
```
