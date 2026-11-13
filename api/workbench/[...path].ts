import { makeRouter } from '../../server/router';
import type { Handler } from '../../server/router';
import * as routes from '../../server/workbench';

export default makeRouter('workbench', routes as unknown as Record<string, Handler>);
