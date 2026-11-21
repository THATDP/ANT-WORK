/**
 * HUD: estoque, vitais, colônia, ameaças, minimapa, toasts e log de eventos.
 * DOM puro — o Phaser cuida do mundo, o HTML cuida da leitura.
 */

import { RESOURCE_KEYS, RESOURCE_INFO, WORLD_PX, CHUNK_PX } from '@shared/constants.js';
import { state, RES_ICON, WEATHER_ICON, clockLabel, fmt, hex } from '../state.js';
import { audio } from '../audio.js';

const $ = (id) => document.getElementById(id);

export const hud = {
  init() {
    const stock = $('hud-stock');
    stock.innerHTML = RESOURCE_KEYS.map((key, i) => `
      <div class="stock-chip" data-res="${key}" title="${RESOURCE_INFO[i].name}">
        <i style="background:${hex(RESOURCE_INFO[i].color)}"></i>
        <span>${RES_ICON[key]}</span>
        <b>0</b>
      </div>`).join('');

    this.minimap = $('minimap');
    this.mctx = this.minimap.getContext('2d');
    this.bigMap = $('big-map');
    this.bctx = this.bigMap.getContext('2d');
    this.lastLogKey = '';
    this.damageTimer = null;
    this.prevHp = 100;
  },

  updateStock(stock, cap) {
    if (!stock) return;
    const total = RESOURCE_KEYS.reduce((s, k) => s + (stock[k] || 0), 0);
    for (const key of RESOURCE_KEYS) {
      const el = document.querySelector(`.stock-chip[data-res="${key}"] b`);
      if (el) el.textContent = fmt(stock[key] || 0);
    }
    const stockBox = $('hud-stock');
    if (stockBox) stockBox.title = `estoque ${Math.round(total)} / ${cap ?? '?'}`;
  },

  updateColony(colony, role) {
    const dot = $('colony-dot');
    if (!colony) {
      $('colony-name').textContent = 'Sem colônia';
      $('colony-sub').textContent = 'use o menu para fundar ou entrar';
      dot.style.background = '#6f6d5f';
      $('stat-pop').textContent = '–';
      $('stat-morale').textContent = '–';
      ['worker', 'scout', 'soldier', 'larva'].forEach((k) => { $(`pop-${k}`).textContent = '0'; });
      $('pop-eggs').textContent = '0';
      $('pop-pending').textContent = '0';
      return;
    }
    const color = colony.color ?? 0xd9b48f;
    dot.style.background = hex(color);
    dot.style.boxShadow = `0 0 0 4px ${hex(color)}22, 0 0 14px ${hex(color)}66`;
    $('colony-name').textContent = colony.name ?? 'Colônia';
    const roleName = role === 'founder' ? 'fundadora' : role === 'officer' ? 'oficial' : 'membro';
    const total = colony.totalPop ?? 0;
    $('colony-sub').textContent = `${roleName} · ${total} formigas`;
    $('stat-pop').textContent = fmt(total);
    const morale = colony.morale ?? 50;
    $('stat-morale').textContent = Math.round(morale);
    $('stat-morale').style.color = morale < 35 ? '#e0533f' : morale < 60 ? '#e9a85b' : '#a9d98a';
    const p = colony.pop || {};
    $('pop-worker').textContent = fmt(p.worker || 0);
    $('pop-scout').textContent = fmt(p.scout || 0);
    $('pop-soldier').textContent = fmt(p.soldier || 0);
    $('pop-larva').textContent = fmt(p.larva || 0);
    $('pop-eggs').textContent = fmt(colony.eggs || 0);
    $('pop-pending').textContent = fmt(colony.pending || 0);
    this.updateStock(colony.stock, colony.cap);
    this.updateTip(colony);
  },

  updateTip(colony) {
    const el = $('tip-text');
    if (!el) return;
    let tip = '';
    if (!colony) {
      tip = 'Você está sem colônia. Colete recursos (E) e funde uma colônia no menu para guardá-los.';
    } else if (!colony.structures) {
      tip = 'Sincronizando o estado da colônia…';
    } else if (colony.foodStress > 0.6 || colony.needs?.hungry) {
      tip = 'A colônia está com fome. Colete folhas, sementes, frutas ou insetos e entregue no ninho (F).';
    } else if (colony.needs?.needMaterial) {
      tip = 'Faltam materiais para as próximas obras. Procure pedras e galhos (E) e construa (B).';
    } else if (colony.eggs > 0 && !colony.structures.some((s) => s.type === 3)) {
      tip = 'Há ovos no ninho. Um berçário acelera a criação das larvas — abra o menu de construção (B).';
    } else if (colony.pending > 0) {
      tip = 'Há obras em andamento. Aproxime-se e pressione E para ajudar a construir mais rápido.';
    } else if (colony.needs?.defence > 0.3) {
      tip = 'Ameaças rondam a colônia. Guerreiras respondem ao alarme — evite lutar sozinho.';
    } else if (colony.totalPop > 40 && !colony.structures.some((s) => s.type === 9)) {
      tip = 'Com muitas formigas, uma Câmara da Rainha aumenta a postura de ovos.';
    } else {
      const tips = [
        'Dica: exploradoras marcam trilhas de comida. Siga as operárias para achar recursos.',
        'Dica: à noite os predadores ficam mais ousados. Volte para perto das guerreiras.',
        'Dica: entregar recursos no ninho mantém a moral e a rainha botando ovos.',
        'Dica: túneis e câmaras exigem solo escavável — evite rochas e água.',
        'Dica: use o chat da colônia (Enter) para combinar uma obra em equipe.',
      ];
      tip = tips[Math.floor((Date.now() / 12000) % tips.length)];
    }
    el.textContent = tip;
  },

  updateVitals(self) {
    if (!self) return;
    const [, , hp, hunger, thirst, kind, amount] = self;
    $('bar-hp').style.width = `${Math.max(0, Math.min(100, (hp / 70) * 100))}%`;
    $('bar-hunger').style.width = `${Math.max(0, Math.min(100, 100 - (hunger / 120) * 100))}%`;
    $('bar-thirst').style.width = `${Math.max(0, Math.min(100, 100 - (thirst / 120) * 100))}%`;
    $('inv-count').textContent = `${amount ?? 0}/${state.inventory.cap ?? 8}`;
    $('inv-icon').textContent = kind >= 0 ? `${RES_ICON[RESOURCE_KEYS[kind]]} ${RESOURCE_INFO[kind]?.name ?? 'recurso'}` : 'vazio';
    $('inv-icon').style.color = kind >= 0 ? hex(RESOURCE_INFO[kind]?.color ?? 0xffffff) : '#6f6d5f';
    if (hp < this.prevHp - 6) this.flashDamage();
    this.prevHp = hp;
  },

  flashDamage() {
    const el = $('damage-flash');
    el.classList.add('on');
    clearTimeout(this.damageTimer);
    this.damageTimer = setTimeout(() => el.classList.remove('on'), 120);
    audio.tone(110, 0.12, 'sawtooth', 0.03, -30);
  },

  updateEnv(env) {
    if (!env) return;
    $('weather-icon').textContent = env.night ? '🌙' : (WEATHER_ICON[env.weather] ?? '☀');
    $('weather-text').textContent = env.weather === 'clear' ? (env.night ? 'noite' : 'limpo') : (env.weather ?? '');
    $('clock-text').textContent = `${clockLabel(env)} · ${env.temperature}°`;
    const fx = $('weather-fx');
    let bg = 'transparent';
    if (env.weather === 'rain') bg = 'linear-gradient(180deg, rgba(40,70,90,0.16), rgba(20,40,55,0.28))';
    else if (env.weather === 'storm') bg = 'linear-gradient(180deg, rgba(25,35,50,0.34), rgba(10,20,30,0.42))';
    else if (env.weather === 'fog') bg = 'linear-gradient(180deg, rgba(190,200,190,0.14), rgba(150,165,155,0.24))';
    else if (env.weather === 'heat') bg = 'linear-gradient(180deg, rgba(200,120,50,0.12), rgba(140,70,30,0.16))';
    else if (env.night) bg = 'linear-gradient(180deg, rgba(12,20,42,0.32), rgba(6,10,24,0.44))';
    else bg = 'linear-gradient(180deg, rgba(255,240,200,0.02), rgba(0,0,0,0.08))';
    fx.style.background = bg;
    audio.setNight(env.night);
  },

  setThreats(list, player) {
    const el = $('threat-list');
    const vig = $('threat-vignette');
    if (!list || !list.length) {
      el.innerHTML = '<span class="muted">nada por perto</span>';
      vig.style.opacity = '0';
      return;
    }
    const nearest = list[0];
    const d = nearest.dist ?? 0;
    vig.style.opacity = String(Math.max(0, Math.min(0.9, 1 - d / 520)));
    el.innerHTML = list.slice(0, 4).map((t) => {
      const angle = Math.atan2(t.y - (player?.y ?? 0), t.x - (player?.x ?? 0));
      const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
      const idx = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      return `<div class="threat-row"><span>${t.name ?? 'predador'}</span><b>${Math.round(t.dist)}</b><span class="dir">${arrows[idx]}</span></div>`;
    }).join('');
  },

  setPrompt(html) {
    const el = $('interact-prompt');
    if (!html) { el.classList.add('hidden'); return; }
    el.innerHTML = html;
    el.classList.remove('hidden');
  },

  toast(text, kind = '', ms = 2600) {
    const wrap = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    wrap.appendChild(el);
    if (wrap.children.length > 5) wrap.firstChild.remove();
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
      el.style.transition = '0.3s';
      setTimeout(() => el.remove(), 320);
    }, ms);
    if (kind === 'error') audio.error();
  },

  log(kind, text, important = false) {
    const list = state.log;
    list.push({ kind, text, at: Date.now() });
    while (list.length > 40) list.shift();
    const wrap = $('event-log');
    const el = document.createElement('div');
    el.className = `log-item ${kind}${important ? ' important' : ''}`;
    el.textContent = text;
    wrap.appendChild(el);
    while (wrap.children.length > 7) wrap.firstChild.remove();
    setTimeout(() => {
      el.style.opacity = '0.35';
      el.style.transition = 'opacity 1.5s';
    }, 9000);
  },

  updatePlayers(players) {
    $('players-count').textContent = players.length;
    const list = $('players-list');
    if (!list) return;
    list.innerHTML = players.map((p) => `
      <div class="player-row">
        <span class="swatch" style="background:${hex(p.color)}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="pinfo">${escapeHtml(p.colony)} · ${Math.round(p.dist)}px</span>
      </div>`).join('') || '<span class="muted">ninguém por perto</span>';
  },

  setConnection(connected, reconnecting) {
    const banner = $('disconnect-banner');
    if (reconnecting) {
      banner.classList.remove('hidden');
      banner.textContent = 'conexão perdida — tentando voltar…';
    } else if (!connected) {
      banner.classList.remove('hidden');
      banner.textContent = 'sem conexão com o servidor';
    } else {
      banner.classList.add('hidden');
    }
  },

  showDeath(show, seconds, reason) {
    const el = $('death-screen');
    if (show) {
      el.classList.remove('hidden');
      $('death-reason').textContent = reason ?? 'o mundo é maior que uma formiga';
      $('death-timer').textContent = `renascendo em ${Math.max(0, Math.ceil(seconds))}s`;
    } else {
      el.classList.add('hidden');
    }
  },

  // ------------------------------------------------------------ minimapa
  drawMinimap(baseCanvas, sceneData) {
    const ctx = this.mctx;
    const S = this.minimap.width;
    ctx.clearRect(0, 0, S, S);
    if (baseCanvas) {
      ctx.globalAlpha = 0.95;
      ctx.drawImage(baseCanvas, 0, 0, S, S);
      ctx.globalAlpha = 1;
    }
    const toMap = (x, y) => ({ x: (x / WORLD_PX) * S, y: (y / WORLD_PX) * S });

    // sua colônia e outras
    for (const colony of state.colonies ?? []) {
      const p = toMap(colony.nest.x, colony.nest.y);
      ctx.fillStyle = hex(colony.color);
      ctx.globalAlpha = colony.id === state.colony?.id ? 0.95 : 0.55;
      ctx.beginPath(); ctx.arc(p.x, p.y, colony.id === state.colony?.id ? 3.4 : 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // estruturas
    if (sceneData?.structures) {
      for (const s of sceneData.structures) {
        const p = toMap(s.wx, s.wy);
        ctx.fillStyle = hex(s.color ?? 0xd7b45a);
        ctx.globalAlpha = 0.5;
        ctx.fillRect(p.x - 0.7, p.y - 0.7, 1.7, 1.7);
      }
      ctx.globalAlpha = 1;
    }
    // predadores
    if (sceneData?.predators) {
      for (const p of sceneData.predators) {
        const m = toMap(p.x, p.y);
        if (Math.hypot(p.x - (sceneData.self?.x ?? p.x), p.y - (sceneData.self?.y ?? p.y)) > 1400) continue;
        ctx.fillStyle = '#e0533f';
        ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.arc(m.x, m.y, 1.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // outros jogadores
    if (state.players.length) {
      for (const p of state.players) {
        const m = toMap(p.x, p.y);
        ctx.fillStyle = hex(p.color);
        ctx.beginPath(); ctx.arc(m.x, m.y, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }
    // você
    if (sceneData?.self) {
      const m = toMap(sceneData.self.x, sceneData.self.y);
      ctx.fillStyle = '#fff8e6';
      ctx.strokeStyle = '#1a1108';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(m.x, m.y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // cone de visão
      const a = sceneData.self.dir ?? 0;
      ctx.strokeStyle = 'rgba(255,240,200,0.35)';
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(m.x + Math.cos(a) * 12, m.y + Math.sin(a) * 12);
      ctx.stroke();
      // retângulo da câmera
      if (sceneData.view) {
        const v0 = toMap(sceneData.view.x, sceneData.view.y);
        const w = (sceneData.view.width / WORLD_PX) * S;
        const h = (sceneData.view.height / WORLD_PX) * S;
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1;
        ctx.strokeRect(v0.x, v0.y, Math.max(4, w), Math.max(4, h));
      }
    }
  },

  drawBigMap(baseCanvas, sceneData) {
    const ctx = this.bctx;
    const S = this.bigMap.width;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#080b07';
    ctx.fillRect(0, 0, S, S);
    if (baseCanvas) ctx.drawImage(baseCanvas, 0, 0, S, S);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#050704';
    ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 1;

    const toMap = (x, y) => ({ x: (x / WORLD_PX) * S, y: (y / WORLD_PX) * S });

    // grade de setores
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const chunkPxMap = (CHUNK_PX / WORLD_PX) * S;
    for (let i = 0; i <= 48; i += 4) {
      ctx.beginPath(); ctx.moveTo(i * chunkPxMap, 0); ctx.lineTo(i * chunkPxMap, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * chunkPxMap); ctx.lineTo(S, i * chunkPxMap); ctx.stroke();
    }

    // estruturas
    if (sceneData?.structures) {
      for (const s of sceneData.structures) {
        const p = toMap(s.wx, s.wy);
        ctx.fillStyle = hex(s.color ?? 0xd7b45a);
        ctx.fillRect(p.x - 1, p.y - 1, 2.4, 2.4);
      }
    }
    // colônias
    for (const colony of state.colonies ?? []) {
      const p = toMap(colony.nest.x, colony.nest.y);
      ctx.fillStyle = hex(colony.color);
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(p.x, p.y, colony.isAi ? 4.5 : 6, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = 'rgba(240,235,220,0.92)';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(colony.name, p.x, p.y - 9);
      ctx.fillStyle = 'rgba(180,175,160,0.7)';
      ctx.font = '9px monospace';
      ctx.fillText(`${colony.pop} formigas${colony.isAi ? ' · selvagem' : ''}`, p.x, p.y + 16);
    }
    // jogadores
    for (const p of state.players) {
      const m = toMap(p.x, p.y);
      ctx.fillStyle = hex(p.color);
      ctx.beginPath(); ctx.arc(m.x, m.y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0b0f0a'; ctx.lineWidth = 1; ctx.stroke();
    }
    // você
    if (sceneData?.self) {
      const m = toMap(sceneData.self.x, sceneData.self.y);
      ctx.strokeStyle = '#fff8e6'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(m.x, m.y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff8e6';
      ctx.beginPath(); ctx.arc(m.x, m.y, 2.6, 0, Math.PI * 2); ctx.fill();
      if (sceneData.view) {
        const v0 = toMap(sceneData.view.x, sceneData.view.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.strokeRect(v0.x, v0.y, (sceneData.view.width / WORLD_PX) * S, (sceneData.view.height / WORLD_PX) * S);
      }
    }
    // marcador clicado
    if (sceneData?.marker) {
      const m = toMap(sceneData.marker.x, sceneData.marker.y);
      ctx.strokeStyle = '#e9a85b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(m.x - 6, m.y); ctx.lineTo(m.x + 6, m.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(m.x, m.y - 6); ctx.lineTo(m.x, m.y + 6); ctx.stroke();
    }
  },

  setUnreadChat(n) {
    const badge = $('chat-badge');
    badge.classList.toggle('hidden', n <= 0);
  },
};

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { $ as qs };
