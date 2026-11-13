import { makeRouter } from '../../server/router';
import type { Handler } from '../../server/router';
import * as routes from '../../server/agent';

export default makeRouter('agent', routes as unknown as Record<string, Handler>);
