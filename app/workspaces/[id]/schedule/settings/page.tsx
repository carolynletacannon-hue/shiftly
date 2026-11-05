import { SchedulingPage } from "../page";
export default async function Page(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  return <SchedulingPage {...props} advanced />;
}
