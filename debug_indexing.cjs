const { indexJavaSources } = require('./out/server/javaIndexer.js');
const indexJavaSource = (sources) => indexJavaSources(sources);
const postService = `package demo;\nimport java.util.List;\nclass PostService {\n  List<Post> findAll() { return List.of(); }\n}`;
const post = `package demo;\nclass Post {\n  private Long id;\n  private String title;\n}`;
const controller = `package demo;\nimport org.springframework.stereotype.Controller;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.ModelAttribute;\nimport org.springframework.web.bind.annotation.RequestMapping;\n@Controller\n@RequestMapping("/users")\nclass UserController {\n  private PostService postService;\n  @GetMapping("/{id}")\n  String list(@ModelAttribute("user") UserForm user, Model model) {\n    model.addAttribute("ps", postService.findAll());\n    return "users/list";\n  }\n}`;

const result = indexJavaSource([
  {filePath: 'PostService.java', source: postService},
  {filePath: 'Post.java', source: post},
  {filePath: 'UserController.java', source: controller}
]);
const svc = result.classes.find(c => c.name === 'PostService');
console.log('PostService methodReturnTypes:', JSON.stringify([...svc.methodReturnTypes]));
const handler = result.handlers[0];
console.log('handler modelAttributes:', JSON.stringify([...handler.modelAttributes]));
console.log('handler modelAttributeExpressions:', JSON.stringify([...handler.modelAttributeExpressions]));
