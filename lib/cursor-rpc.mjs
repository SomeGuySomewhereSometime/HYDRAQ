import { AcpRpc } from './acp-rpc.mjs';

/** Original Cursor launch profile; shared ACP framing never retries mutations. */
export class CursorRpc extends AcpRpc {
  constructor(options) { super({ ...options, args: [...(options.args || []), '--sandbox', 'enabled', 'acp'], env: {...options.env, CURSOR_API_KEY:options.secret} }); }
}
