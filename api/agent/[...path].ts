import { makeRouter } from '../_router';
import type { Handler } from '../_router';
import * as routes from '../_agent';

export default makeRouter('agent', routes as unknown as Record<string, Handler>);
