import PresentationDashboard from '@/components/PresentationDashboard';

export default function Home({ searchParams }: { searchParams: { videoRecorded?: string } }) {
  return <PresentationDashboard initialVideoRecordedTopicId={searchParams.videoRecorded} />;
}
