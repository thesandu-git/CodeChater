import { makeRouter } from '../_router';
import type { Handler } from '../_router';
import * as routes from '../_studio';

export default makeRouter('studio', routes as unknown as Record<string, Handler>);
