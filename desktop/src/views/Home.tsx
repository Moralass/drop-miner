import Summary from "../components/Summary";
import AccountsPanel from "../components/AccountsPanel";
import ActivePanel from "../components/ActivePanel";
import DropsList from "../components/DropsList";
import type { Ctx } from "./ctx";

export default function Home({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <div className="ph"><h1>Главная</h1></div>
      <Summary accounts={ctx.accounts} states={ctx.states} stats={ctx.stats} unread={ctx.unread} onOpenNotifications={() => ctx.go("notifications")} />
      <div className="cols">
        <AccountsPanel ctx={ctx} />
        <ActivePanel ctx={ctx} />
      </div>
      <DropsList ctx={ctx} />
    </>
  );
}
