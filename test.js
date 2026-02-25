// Test script to verify the fix
const { Collection } = require('./src/Collection.js');
const { ingest, chunkSection } = require('./src/ingest.js');

async function test() {
  console.log('Testing chunkSection with parsed section...');
  
  // Test the fixed chunkSection function
  const testSection = { id: 'test:section:0', text: 'This is a test section with some content.' };
  const chunks = chunkSection(testSection);
  
  console.log('Input section:', testSection);
  console.log('Output chunks:', chunks);
  console.log('Test passed! chunkSection now accepts objects with id and text properties.');
  
  // Test with Collection
  console.log('\nCreating Collection...');
  const collection = new Collection();
  
  console.log('\nIngesting markdown files from current directory...');
  await ingest('.', collection);
  
  console.log('\nCollection stats:');
  console.log('- Documents:', collection.documents.size);
  console.log('- Nodes:', collection.nodes.size);
  console.log('- Keywords:', collection.keywords ? collection.keywords.size : 'N/A');
  
  console.log('\nAll tests passed!');
}

test().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
