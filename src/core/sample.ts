// DEVELOPMENT FIXTURE – fictional people for trying the database without scraping. Nothing here is a real researcher; the e-mail
// domains are reserved (.example) and can never be delivered. Loaded only when you press "Load sample data".
import { fid } from './defaults';

const p = (name: string, position: string, department: string, institution: string, country: string, email: string, keywords: string, about: string, slug: string): Record<string, string> => ({
  [fid('fullName')]: name, [fid('position')]: position, [fid('department')]: department, [fid('institution')]: institution, [fid('country')]: country,
  [fid('email')]: email, [fid('researchKeywords')]: keywords, [fid('about')]: about, [fid('profileUrl')]: `https://sample.example/people/${slug}`,
});

export const SAMPLE_RESEARCHERS: Record<string, string>[] = [
  p('Prof. Anna Example', 'Professor of Analytical Chemistry', 'Department of Chemistry', 'Example University', 'Netherlands', 'anna.example@example-university.example', 'mass spectrometry, chromatography', 'Leads the separation science group.', 'anna-example'),
  p('Dr. Bram Fixture', 'Associate Professor', 'Department of Biology', 'Fixture Institute of Technology', 'Germany', 'bram.fixture@fixture-institute.example', 'cell culture, microscopy', 'Works on live-cell imaging.', 'bram-fixture'),
  p('Dr. Chen Sample', 'Senior Researcher', 'Materials Laboratory', 'Sample Research Centre', 'Singapore', '', 'nanomaterials, spectroscopy', '', 'chen-sample'),
  p('Dr. Dewi Placeholder', 'Lecturer', 'Faculty of Pharmacy', 'Placeholder University', 'Indonesia', 'dewi.placeholder@placeholder-univ.example', 'phytochemistry, bioassays', 'Natural products and drug discovery.', 'dewi-placeholder'),
];
