import { makeRouter } from '../_router';
import type { Handler } from '../_router';
import * as routes from '../_workbench';

export default makeRouter('workbench', routes as unknown as Record<string, Handler>);
