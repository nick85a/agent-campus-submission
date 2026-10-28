import { Store } from "../src/store.ts";
import { SchedulerService } from "../src/service.ts";
import { request, at } from "./helpers.ts";
const store = new Store(process.argv[2], process.argv[3]);
try {
  const service = new SchedulerService(store), s = service.open(request());
  process.stdout.write(JSON.stringify(service.saveDraft(s.id, "M01", "douyin", at(17))));
} finally { store.close(); }
