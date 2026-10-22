import { afterAll, it } from "vitest";
import { close, pay } from "./payments.ts";

afterAll(close);

it("pays an invoice", pay);
