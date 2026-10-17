import DropsList from "../components/DropsList";
import type { Ctx } from "./ctx";

export default function Drops({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <div className="ph"><h1>Drops</h1></div>
      <DropsList ctx={ctx} />
    </>
  );
}
