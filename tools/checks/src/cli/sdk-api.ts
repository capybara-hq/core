import { checkSdkApi } from "../sdk-api.js";
import { reportEn } from "./report.js";

reportEn("SDK API snapshot", await checkSdkApi({ update: false }));
