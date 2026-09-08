export const article = `<html><body><nav>Navegação que deve ser ignorada.</nav>
<article><h1>Evento oficial de teste</h1>
<p>A Supercell publicou um comunicado oficial sobre um evento de Brawl Stars.
O comunicado informa que as regras serão apresentadas nos canais oficiais.
Não foram divulgadas recompensas, datas adicionais ou mudanças de balanceamento.
Os jogadores devem conferir as orientações oficiais antes de participar.</p>
</article><footer>Rodapé que deve ser ignorado.</footer></body></html>`;

export const analysis = {
  resumo: "A Supercell publicou um comunicado oficial sobre um evento de Brawl Stars. As regras serão apresentadas nos canais oficiais.",
  classificacao: "Evento", prioridade: "Média",
  publico_alvo: "Jogadores interessados em acompanhar os eventos oficiais.",
  angulo_diferenciado: "Separar as informações confirmadas dos detalhes que ainda não foram anunciados.",
  gancho_abertura: "O evento foi anunciado oficialmente, mas alguns detalhes ainda precisam de confirmação.",
  titulos: ["Evento oficial de Brawl Stars", "O que já sabemos do evento", "Evento: informações confirmadas"],
  conceito_thumbnail: "Imagem oficial do evento com o texto EVENTO OFICIAL.",
  estrategia_retencao: "Começar pelo anúncio confirmado, explicar o que falta e indicar onde conferir as regras.",
  experimento_crescimento: "Testar apenas o gancho e comparar a retenção com o histórico do canal.",
  roteiro_curto: "A Supercell publicou um comunicado oficial sobre um evento de Brawl Stars. As regras serão apresentadas nos canais oficiais. ".repeat(4),
  pontos_a_verificar: "Conferir as regras quando forem publicadas nos canais oficiais.",
};

export function archive(url, edition) {
  if (url.hostname === "www.youtube.com") {
    return { contentType: "application/atom+xml", body: `<feed>
      <entry><yt:videoId>video000001</yt:videoId><title>Primeiro vídeo</title></entry>
      <entry><yt:videoId>video000002</yt:videoId><title>Segundo vídeo</title></entry></feed>` };
  }
  const announcements = url.pathname.includes("/announcement/");
  const path = announcements ? "/en/news/" : "/en/games/brawlstars/blog/news/";
  const count = announcements ? 2 : edition;
  return { contentType: "text/html", body: Array.from({ length: count }, (_, index) =>
    `<a href="${path}evento-${index}/">Evento oficial ${index}</a>`).join("") };
}
