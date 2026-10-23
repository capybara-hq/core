import { checkSdkApi } from "../sdk-api.js";
import { report } from "./report.js";

report("SDK API snapshot", await checkSdkApi({ update: false }));
