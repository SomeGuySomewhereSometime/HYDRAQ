// Original vector artwork. Every moving part has a local origin for the rig in
// mascot-character.js; this module draws the character and has no animation loop.
let artworkSequence = 0;

export function createHydraArtwork() {
  const id = `hydra-art-${++artworkSequence}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 260 220');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('mascot-svg');

  const leg = (index, back = false) => `
    <g data-rig="leg-${index}" stroke-linecap="round" stroke-linejoin="round">
      <path data-leg-upper="${index}" d="M${index % 2 ? 149 : 107} 156l0 16" fill="none" stroke="${back ? '#235e53' : '#388974'}" stroke-width="${back ? 12 : 13}"/>
      <path data-leg-lower="${index}" d="M${index % 2 ? 149 : 107} 172l0 10" fill="none" stroke="${back ? '#3b806a' : '#68b99a'}" stroke-width="10"/>
      <g data-leg-foot="${index}" transform="translate(${index % 2 ? 149 : 107} 184)">
        <path d="M-8 0Q-9-7-2-7H3Q10-7 11 2Q12 7 6 7H-5Q-11 7-8 0Z" fill="${back ? '#4b9a7c' : '#81c9a7'}" stroke="#214f45" stroke-width="1.25"/>
        <path d="M-5 2l-.1 3.3M.5 2.6v3.3M6 2l.4 3.1" stroke="#d9ebbd" stroke-width="2.1"/>
      </g>
    </g>`;

  const neck = index => {
    const paths = [
      'M114 139C104 129 88 119 81 109',
      'M130 140C129 120 130 102 130 83',
      'M145 139C157 130 171 121 176 111',
    ];
    return `<g data-rig="neck-${index}" fill="none" stroke-linecap="round">
      <path data-neck="${index}" d="${paths[index]}" stroke="url(#${id}-neck-${index})" stroke-width="23"/>
      <path data-neck-belly="${index}" d="${paths[index]}" stroke="#bce0b1" stroke-width="9" opacity=".88"/>
    </g>`;
  };

  const eye = (head, side, x) => `
    <g transform="translate(${x} -2)">
      <g data-eye="${head}-${side}">
        <ellipse cx="0" cy="0" rx="7.1" ry="8.6" fill="#f8f5de" stroke="#2d5749" stroke-width="1.25"/>
        <g data-pupil="${head}-${side}">
          <ellipse cx=".5" cy=".3" rx="4.8" ry="6.6" fill="var(--mascot-provider, #62c9aa)"/>
          <ellipse cx=".7" cy="1" rx="2.5" ry="4.5" fill="#153c36"/>
          <ellipse cx="2.1" cy="-2.5" rx="1.8" ry="2.1" fill="#fff" opacity=".95"/>
          <circle cx="-1.1" cy="3.5" r=".85" fill="#fff" opacity=".55"/>
        </g>
      </g>
    </g>
    <path data-brow="${head}-${side}" d="M${x - 5.5}-13Q${x} -15.5 ${x + 4}-13.7" fill="none" stroke="#285e4e" stroke-width="1.8" stroke-linecap="round"/>`;

  const head = index => {
    const poses = ['translate(80 94) rotate(-8)', 'translate(130 66)', 'translate(178 97) rotate(8)'];
    return `
    <g data-head="${index}" transform="${poses[index]}">
      <path d="M-20-12Q-31-23-34-16L-31-8-24-1M21-12Q33-22 35-15L31-7 24 0" fill="#5bad8b" stroke="#235d50" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M-19-21Q-24-37-15-34Q-11-34-11-25M12-25Q13-36 19-34Q25-31 21-20" fill="url(#${id}-horn)" stroke="#8c8d4e" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M-25-2C-28-17-19-27-5-28C8-31 23-25 26-10C28 0 25 11 17 17Q3 25-13 18C-23 14-27 7-25-2Z" fill="url(#${id}-head-${index})" stroke="#1c5649" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M-5-27Q-4-36 2-33L5-27M2-27Q6-33 10-29L10-25" fill="#4a9b7b" stroke="#306d57" stroke-width="1"/>
      <path d="M-22-7Q-20-22-7-24" fill="none" stroke="#d2f3bd" stroke-width="2" opacity=".42" stroke-linecap="round"/>
      ${eye(index, 0, -10)}
      ${eye(index, 1, 11)}
      <ellipse cx="-19" cy="8.5" rx="4.1" ry="2.3" fill="#f0bc9c" opacity=".55"/>
      <ellipse cx="20" cy="8.5" rx="3.7" ry="2.2" fill="#f0bc9c" opacity=".55"/>
      <path d="M-14 7C-10 3-4 5 0 7C5 4 12 4 16 8C22 17 8 22 1 22C-8 22-22 17-14 7Z" fill="#c0dfab" stroke="#5e9878" stroke-width=".7"/>
      <ellipse cx="-5.3" cy="8" rx="1.1" ry=".85" fill="#487b62"/>
      <ellipse cx="6.1" cy="8" rx="1.1" ry=".85" fill="#487b62"/>
      <g transform="translate(1 14)">
        <g data-jaw="${index}" transform="scale(1 .08)">
          <path d="M-8 0Q0 4 8 0Q7 10 0 10Q-7 9-8 0Z" fill="#244b40"/>
          <path d="M-4.5 7Q0 3.5 4.5 7Q1 11-2 9.5Z" fill="#e6a493"/>
          <path d="M-6 .5l1.1 3.1L-3 .9M3.5 1l1.6 2.4L6 .6" fill="#fff5ce"/>
        </g>
      </g>
      <path data-mouth="${index}" d="M-7 14Q1 19 9 14" fill="none" stroke="#315f4b" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M-18-18l2-1M18-18l2 1" stroke="#c4e6b2" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>
    </g>`;
  };

  svg.innerHTML = `
    <defs>
      <linearGradient id="${id}-body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#88d4ad"/><stop offset=".55" stop-color="#4baf8c"/><stop offset="1" stop-color="#28765f"/></linearGradient>
      <linearGradient id="${id}-belly" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#e6efbd"/><stop offset="1" stop-color="#aed0a1"/></linearGradient>
      <linearGradient id="${id}-horn" x1="0" y1="1" x2=".2" y2="0"><stop stop-color="#e9bf76"/><stop offset="1" stop-color="#fff0bb"/></linearGradient>
      ${[0, 1, 2].map(i => `<linearGradient id="${id}-head-${i}" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="${['#99debc', '#b5e8c3', '#87cfb2'][i]}"/><stop offset=".56" stop-color="${['#72c5a5', '#87d3aa', '#66b99c'][i]}"/><stop offset="1" stop-color="#4b9c7f"/></linearGradient>
      <linearGradient id="${id}-neck-${i}" x1="0" y1="1" x2=".3" y2="0"><stop stop-color="#4a9e7f"/><stop offset="1" stop-color="${['#76c4a1', '#8bd3aa', '#6cbb9b'][i]}"/></linearGradient>`).join('')}
    </defs>
    <ellipse data-rig="shadow" cx="133" cy="194" rx="60" ry="7" fill="#123e37" opacity=".18"/>
    <g data-rig="creature">
      <g data-rig="tail">
        <path d="M154 154C182 169 199 159 201 141Q202 128 214 123Q197 118 192 133C188 144 178 145 164 139Z" fill="url(#${id}-body)" stroke="#245b4d" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M198 133Q196 119 207 117L214 123Z" fill="#9dd2a3" stroke="#3d7e5e" stroke-width="1.1"/>
        <path d="M168 153Q189 158 195 145" fill="none" stroke="#9fdbad" stroke-width="2" stroke-linecap="round" opacity=".55"/>
      </g>
      ${leg(0, true)}${leg(1, true)}
      <g data-rig="body">
        <path d="M94 143C95 126 107 119 127 120C149 118 164 129 168 147C173 167 158 180 134 181C111 183 89 170 94 143Z" fill="url(#${id}-body)" stroke="#235b4d" stroke-width="1.8"/>
        <path d="M113 136Q131 128 148 138C158 150 157 166 145 175Q130 184 114 173C103 163 104 145 113 136Z" fill="url(#${id}-belly)"/>
        <path d="M110 149Q130 155 153 149M109 159Q131 166 154 159M114 170Q132 175 149 170" fill="none" stroke="#7caf84" stroke-width="1.25" opacity=".5"/>
        <path d="M98 136l-5-6 9 1M97 147l-7-3 7-3" fill="#a3cf96" stroke="#3a7e5d" stroke-width="1.1" stroke-linejoin="round"/>
        <ellipse cx="99" cy="155" rx="2" ry="3.1" fill="#b5e1a1" opacity=".5"/>
        <ellipse cx="161" cy="151" rx="2" ry="3.5" fill="#b5e1a1" opacity=".4"/>
      </g>
      ${neck(0)}${neck(2)}${neck(1)}
      ${leg(2)}${leg(3)}
      ${head(0)}${head(2)}${head(1)}
    </g>`;
  return svg;
}
