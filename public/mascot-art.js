// Faísca Trio, com as três cores fixas da versão aprovada.
export const faiscaArtwork = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 300" class="mascot-svg" focusable="false">
  <defs>
    <linearGradient id="faisca-body" x2=".7" y2="1">
      <stop stop-color="#d9deec" />
      <stop offset=".42" stop-color="#909bb5" />
      <stop offset="1" stop-color="#40465e" />
    </linearGradient>
    <linearGradient id="faisca-0" x1="0" y1="0" x2=".7" y2="1">
      <stop stop-color="#fff1d4" />
      <stop offset=".48" stop-color="#eaa574" />
      <stop offset="1" stop-color="#b76448" />
    </linearGradient>
    <linearGradient id="faisca-1" x1="0" y1="0" x2=".7" y2="1">
      <stop stop-color="#eaffdf" />
      <stop offset=".48" stop-color="#75d2af" />
      <stop offset="1" stop-color="#328b78" />
    </linearGradient>
    <linearGradient id="faisca-2" x1="0" y1="0" x2=".7" y2="1">
      <stop stop-color="#ecfbff" />
      <stop offset=".48" stop-color="#80d4ed" />
      <stop offset="1" stop-color="#438db4" />
    </linearGradient>
  </defs>
  <ellipse cx="160" cy="270" rx="76" ry="6" fill="#8999ae" opacity=".12" />
  <g class="float">
    <g class="tail">
      <path d="M175 222C217 250 266 233 274 199Q283 184 272 165Q300 188 287 218Q309 205 301 182C332 227 284 267 223 256L178 244Z" fill="url(#faisca-body)" />
      <path d="M224 248Q276 249 287 213Q274 237 224 240" fill="#eef1ff" opacity=".65" />
    </g>
    <g class="neck" data-client="claude">
      <path d="M140 231C132 193 75 194 83 150" stroke="#b76448" stroke-width="29" fill="none" stroke-linecap="round" />
      <path d="M143 229C138 190 84 188 86 148" stroke="url(#faisca-0)" stroke-width="23" fill="none" stroke-linecap="round" />
      <g transform="translate(83 138) rotate(-19)">
        <path d="M-26 3Q-42-8-33-26Q-29-14-18-15M22-15Q35-26 34-36Q48-16 30 1" fill="#b76448" />
        <path d="M-28-2Q-30-16-15-24Q-20-36-9-46Q-10-30 2-28Q8-46 20-52Q12-30 28-21Q43-10 34 9Q27 25 4 25Q-24 24-28-2Z" fill="url(#faisca-0)" />
        <path d="M-20-5Q-22-15-11-19Q-13-29-9-34Q-5-20 6-17Q15-24 16-34Q24-25 21-16Q33-8 27 6Q15 20-4 18Q-18 15-20-5" fill="#fff1d4" />
        <g class="eyes">
          <path d="M-20-5Q-11-9-4-2Q-6 10-13 7Q-18 5-20-5M6-2Q14-9 23-5Q21 6 14 7Q8 7 6-2" fill="#25343e" />
          <ellipse cx="-11" cy="0" rx="2.5" ry="3" fill="white" />
          <ellipse cx="15" cy="0" rx="2.5" ry="3" fill="white" />
        </g>
        <path class="asleep" d="M-19 2Q-12 8-5 2M7 2Q14 8 22 2" stroke="#25343e" fill="none" stroke-width="2.5" stroke-linecap="round" />
        <path class="smile" d="M-5 14Q3 19 12 12" stroke="#39434b" fill="none" stroke-width="1.8" stroke-linecap="round" />
        <path class="talk" d="M-5 13Q3 18 12 12Q10 25 3 24Q-3 23-5 13" fill="#39434b" />
        <path class="worry" d="M-4 18Q3 11 11 18" stroke="#39434b" fill="none" stroke-width="2" />
        <ellipse cx="-22" cy="9" rx="4" ry="2" fill="#eaa574" opacity=".7" />
        <ellipse cx="24" cy="9" rx="4" ry="2" fill="#eaa574" opacity=".7" />
      </g>
    </g>
    <g class="neck" data-client="codex">
      <path d="M161 231C153 193 153 194 161 111" stroke="#328b78" stroke-width="29" fill="none" stroke-linecap="round" />
      <path d="M164 229C159 190 162 188 164 109" stroke="url(#faisca-1)" stroke-width="23" fill="none" stroke-linecap="round" />
      <g transform="translate(161 99) rotate(0)">
        <path d="M-26 3Q-42-8-33-26Q-29-14-18-15M22-15Q35-26 34-36Q48-16 30 1" fill="#328b78" />
        <path d="M-28-2Q-30-16-15-24Q-20-36-9-46Q-10-30 2-28Q8-46 20-52Q12-30 28-21Q43-10 34 9Q27 25 4 25Q-24 24-28-2Z" fill="url(#faisca-1)" />
        <path d="M-20-5Q-22-15-11-19Q-13-29-9-34Q-5-20 6-17Q15-24 16-34Q24-25 21-16Q33-8 27 6Q15 20-4 18Q-18 15-20-5" fill="#eaffdf" />
        <g class="eyes">
          <path d="M-20-5Q-11-9-4-2Q-6 10-13 7Q-18 5-20-5M6-2Q14-9 23-5Q21 6 14 7Q8 7 6-2" fill="#25343e" />
          <ellipse cx="-11" cy="0" rx="2.5" ry="3" fill="white" />
          <ellipse cx="15" cy="0" rx="2.5" ry="3" fill="white" />
        </g>
        <path class="asleep" d="M-19 2Q-12 8-5 2M7 2Q14 8 22 2" stroke="#25343e" fill="none" stroke-width="2.5" stroke-linecap="round" />
        <path class="smile" d="M-5 14Q3 19 12 12" stroke="#39434b" fill="none" stroke-width="1.8" stroke-linecap="round" />
        <path class="talk" d="M-5 13Q3 18 12 12Q10 25 3 24Q-3 23-5 13" fill="#39434b" />
        <path class="worry" d="M-4 18Q3 11 11 18" stroke="#39434b" fill="none" stroke-width="2" />
        <ellipse cx="-22" cy="9" rx="4" ry="2" fill="#75d2af" opacity=".7" />
        <ellipse cx="24" cy="9" rx="4" ry="2" fill="#75d2af" opacity=".7" />
      </g>
    </g>
    <g class="neck" data-client="antigravity">
      <path d="M181 231C173 193 230 194 238 151" stroke="#438db4" stroke-width="29" fill="none" stroke-linecap="round" />
      <path d="M184 229C179 190 239 188 241 149" stroke="url(#faisca-2)" stroke-width="23" fill="none" stroke-linecap="round" />
      <g transform="translate(238 139) rotate(19)">
        <path d="M-26 3Q-42-8-33-26Q-29-14-18-15M22-15Q35-26 34-36Q48-16 30 1" fill="#438db4" />
        <path d="M-28-2Q-30-16-15-24Q-20-36-9-46Q-10-30 2-28Q8-46 20-52Q12-30 28-21Q43-10 34 9Q27 25 4 25Q-24 24-28-2Z" fill="url(#faisca-2)" />
        <path d="M-20-5Q-22-15-11-19Q-13-29-9-34Q-5-20 6-17Q15-24 16-34Q24-25 21-16Q33-8 27 6Q15 20-4 18Q-18 15-20-5" fill="#ecfbff" />
        <g class="eyes">
          <path d="M-20-5Q-11-9-4-2Q-6 10-13 7Q-18 5-20-5M6-2Q14-9 23-5Q21 6 14 7Q8 7 6-2" fill="#25343e" />
          <ellipse cx="-11" cy="0" rx="2.5" ry="3" fill="white" />
          <ellipse cx="15" cy="0" rx="2.5" ry="3" fill="white" />
        </g>
        <path class="asleep" d="M-19 2Q-12 8-5 2M7 2Q14 8 22 2" stroke="#25343e" fill="none" stroke-width="2.5" stroke-linecap="round" />
        <path class="smile" d="M-5 14Q3 19 12 12" stroke="#39434b" fill="none" stroke-width="1.8" stroke-linecap="round" />
        <path class="talk" d="M-5 13Q3 18 12 12Q10 25 3 24Q-3 23-5 13" fill="#39434b" />
        <path class="worry" d="M-4 18Q3 11 11 18" stroke="#39434b" fill="none" stroke-width="2" />
        <ellipse cx="-22" cy="9" rx="4" ry="2" fill="#80d4ed" opacity=".7" />
        <ellipse cx="24" cy="9" rx="4" ry="2" fill="#80d4ed" opacity=".7" />
      </g>
    </g>
    <path d="M128 208Q101 214 108 237Q117 260 157 259Q195 262 214 239Q228 216 200 205Q181 198 169 211Q158 225 175 231Q187 235 195 224Q195 245 162 246Q132 247 128 233Q124 223 138 217Z" fill="url(#faisca-body)" />
    <path d="M130 237Q150 252 179 241" fill="none" stroke="#e1e7f1" stroke-width="4" stroke-linecap="round" />
    <path d="M121 222Q106 221 99 234L121 238M202 220Q218 218 224 231L206 237" fill="#919db5" />
    <path class="heart" d="M157 179C144 166 141 179 149 185L160 194 171 185C180 177 174 168 167 173L160 180Z" fill="#ffb1a1" />
    <path class="spark" d="M43 109l2 4 4 1-4 2-2 4-1-4-4-2 4-1Z" fill="#eaa574" />
    <path class="spark" d="M274 85l2 4 4 1-4 2-2 4-1-4-4-2 4-1Z" fill="#80d4ed" />
    <path class="spark" d="M112 55l2 4 4 1-4 2-2 4-1-4-4-2 4-1Z" fill="#75d2af" />
    <g class="signal" fill="none" stroke="#d9cda6" stroke-width="2">
      <circle cx="161" cy="37" r="7" />
      <path d="M148 30a15 15 0 0 1 26 0" />
    </g>
    <text class="asleep" x="263" y="100" fill="#b9c8d5" font-family="sans-serif" font-size="15">z z</text>
  </g>
</svg>
`;
